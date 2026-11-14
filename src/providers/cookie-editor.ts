// The cookie editor: the cookies the window holds for the music site and
// Google, without their values, and a box to sign in with cookies pasted from
// a browser that is signed in. Google's sign-in inside the app can't use
// passkeys, which need a browser.
import { join } from 'node:path';

import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';

import * as config from '@/config';
import { t } from '@/i18n';
import { isAppPage } from '@/utils/app-page';
import { checkPastedCookies } from '@/utils/pasted-cookies';

export type ListedCookie = Omit<Electron.Cookie, 'value'>;

const musicUrl = config.defaultConfig.url;
const hostOf = (domain = '') => domain.replace(/^\./, '');

/** The window's cookies of the music site and Google */
const appCookies = async (jar: Electron.Cookies) =>
  (await jar.get({})).filter(({ domain }) =>
    isAppPage({ protocol: 'https:', hostname: hostOf(domain) }),
  );

// What the editor sees: names and flags, never a value
const listed = async (jar: Electron.Cookies): Promise<ListedCookie[]> =>
  (await appCookies(jar))
    .map(
      ({
        name,
        domain,
        hostOnly,
        path,
        secure,
        httpOnly,
        session,
        expirationDate,
        sameSite,
      }) => ({
        name,
        domain,
        hostOnly,
        path,
        secure,
        httpOnly,
        session,
        expirationDate,
        sameSite,
      }),
    )
    .sort(
      (a, b) =>
        hostOf(a.domain).localeCompare(hostOf(b.domain)) ||
        a.name.localeCompare(b.name),
    );

const urlOf = ({ domain, path }: ListedCookie) =>
  `https://${hostOf(domain)}${path ?? '/'}`;

// An expired copy replaces the one cookie. Electron's remove() takes a URL and
// a name, and would also remove a cookie of that name on a parent domain.
const removeOne = (jar: Electron.Cookies, cookie: ListedCookie) =>
  jar.set({
    url: urlOf(cookie),
    name: cookie.name,
    value: '',
    domain: cookie.hostOnly ? undefined : hostOf(cookie.domain),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: 1,
  });

/** Signs out, or makes room for another account; the number of cookies that stayed */
const removeAll = async (jar: Electron.Cookies) =>
  (
    await Promise.allSettled(
      (await appCookies(jar)).map((cookie) =>
        jar.remove(urlOf(cookie), cookie.name),
      ),
    )
  ).filter(({ status }) => status === 'rejected').length;

// The page signs in or out as it loads. The downloader starts its session
// again on its own when the sign-in cookie changes, so no restart is needed.
const reloadMusic = (win: BrowserWindow) => {
  if (
    URL.parse(win.webContents.getURL())?.hostname ===
    URL.parse(musicUrl)?.hostname
  )
    win.webContents.reload();
  else win.webContents.loadURL(musicUrl);
};

let editor: BrowserWindow | undefined;
// The view to open in, when the editor was asked for from Google's sign-in
let startView: 'list' | 'text' | undefined;
// Only the editor may read or change the cookies: the music page's bridge
// reaches the same handlers
const fromEditor = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  editor !== undefined &&
  !editor.isDestroyed() &&
  event.sender === editor.webContents;
const music = () => {
  const parent = editor?.getParentWindow();
  if (!parent || parent.isDestroyed()) throw new Error('No music window');
  return parent;
};

/** Opens the cookie editor, or brings it to the front */
export const openCookieEditor = (
  parent: BrowserWindow,
  view?: 'list' | 'text',
) => {
  if (editor && !editor.isDestroyed()) {
    if (view) editor.webContents.send('peard:cookies-view', view);
    return editor.focus();
  }
  startView = view;
  // Built next to the main process's code by build:cookies
  const folder = join(import.meta.dirname, '..', 'cookies');
  editor = new BrowserWindow({
    parent,
    title: t('main.dialog.cookies.editor.title'),
    width: 860,
    height: 640,
    minWidth: 600,
    minHeight: 440,
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: join(folder, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Not the app's menu, whose items act on the music window
  editor.removeMenu();
  editor.webContents.on('will-navigate', (event) => event.preventDefault());
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.once('ready-to-show', () => editor?.show());
  editor.on('closed', () => {
    editor = undefined;
  });
  editor.loadFile(join(folder, 'index.html'));
};

export const setupCookieEditor = () => {
  const guard = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!fromEditor(event)) throw new Error('Not the cookie editor');
    return music().webContents.session.cookies;
  };
  ipcMain.handle('peard:cookies-load', async (event) => ({
    cookies: await listed(guard(event)),
    view: startView ?? null,
    // Raw, for the editor to fill in
    text: t('main.dialog.cookies.editor', {
      returnObjects: true,
      skipInterpolation: true,
    }),
  }));
  ipcMain.handle(
    'peard:cookies-remove',
    async (event, name: unknown, domain: unknown, path: unknown) => {
      const jar = guard(event);
      const cookie = (await appCookies(jar)).find(
        (one) =>
          one.name === name && one.domain === domain && one.path === path,
      );
      if (cookie) {
        await removeOne(jar, cookie);
        await jar.flushStore();
      }
      return listed(jar);
    },
  );
  // The editor asks before these two
  ipcMain.handle('peard:cookies-remove-all', async (event) => {
    const jar = guard(event);
    const win = music();
    const failed = await removeAll(jar);
    await jar.flushStore();
    reloadMusic(win);
    return { cookies: await listed(jar), failed };
  });
  ipcMain.handle('peard:cookies-export', async (event, format: unknown) => {
    const jar = guard(event);
    // Chrome's cookie objects, as Cookie-Editor exports them; the header as
    // the browser sends it to the music site
    const cookies =
      format === 'header'
        ? await jar.get({ url: musicUrl })
        : await appCookies(jar);
    await clipboard.writeText(
      format === 'header'
        ? cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
        : JSON.stringify(cookies, null, 2),
    );
    return cookies.length;
  });
  ipcMain.handle('peard:cookies-sign-in', async (event, text: unknown) => {
    const jar = guard(event);
    const win = music();
    // The editor checked the paste; Rien checks it again before it signs in
    const { cookies, signIn } = checkPastedCookies(String(text));
    if (signIn !== 'yes') throw new Error(t('main.dialog.cookies.signed-out'));
    // No two sessions mix: with some of the old cookies left, none is set
    const left = await removeAll(jar);
    if (left > 0) {
      await jar.flushStore();
      reloadMusic(win);
      return { failed: 0, count: 0, left, cookies: await listed(jar) };
    }
    const results = await Promise.allSettled(
      cookies.map((cookie) => jar.set(cookie)),
    );
    await jar.flushStore();
    reloadMusic(win);
    return {
      failed: results.filter(({ status }) => status === 'rejected').length,
      count: cookies.length,
      left: 0,
      cookies: await listed(jar),
    };
  });
  ipcMain.on('peard:cookies-close', (event) => {
    if (fromEditor(event)) editor?.close();
  });
};
