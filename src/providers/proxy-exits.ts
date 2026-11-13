// Rien's proxy: one proxy, or a list of exits that Rien moves along when
// YouTube distrusts the one in use. Google asks signed-out players on such a
// network to "confirm you're not a bot" and refuses some of its requests; a
// cleaner exit gets through.
import path from 'node:path';

import { deepmerge } from 'deepmerge-ts';
import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  session,
} from 'electron';

import * as config from '@/config';
import { t } from '@/i18n';
import { defaultAuthProxyConfig } from '@/plugins/auth-proxy-adapter/config';
import {
  activeExits,
  checkedList,
  exitRules,
  pacer,
} from '@/utils/proxy-exits';

export type ExitReason = 'bot-check' | 'refused' | 'manual';
export type ExitChange = {
  exit: number;
  of: number;
  proxy: string;
  reason: ExitReason;
};

// The exits that are on; the ones switched off keep their place in the list
const exits = () => activeExits(config.get('options.proxyExits') ?? []);
const position = () => {
  const count = exits().length;
  const at = config.get('options.proxyExit') ?? 0;
  return count ? ((at % count) + count) % count : 0;
};
const inUse = () => exits()[position()];

/** The proxy rules Rien starts with: its exits from the one in use, or its one proxy */
export const startupProxy = async () => {
  if (exits().length > 0) return exitRules(exits(), position());
  const proxy = config.get('options.proxy');
  if (!proxy) return '';
  if (await config.plugins.isEnabled('auth-proxy-adapter')) {
    // The adapter's local proxy, which logs in to the proxy set
    const { hostname, port } = deepmerge(
      defaultAuthProxyConfig,
      config.get('plugins.auth-proxy-adapter') ?? {},
    ) as typeof defaultAuthProxyConfig;
    return `socks5://${hostname}:${port}`;
  }
  return proxy;
};

const useExit = async (at: number, reason?: ExitReason) => {
  const list = exits();
  config.set('options.proxyExit', at);
  // New requests go through it; the sockets of the exit before stay in a
  // pool of their own
  await session.defaultSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: exitRules(list, at),
  });
  if (!reason) return;
  const change: ExitChange = {
    exit: at + 1,
    of: list.length,
    proxy: list[at],
    reason,
  };
  // For the API server's live feed, as the page's events reach it
  ipcMain.emit('peard:exit-changed', {}, change);
};

// Each exit at most once every 10 minutes when Rien moves by itself
const allow = pacer(10 * 60 * 1000);

/** Moves to the next exit; false when there is none to move to */
export const nextExit = async (reason: ExitReason) => {
  const count = exits().length;
  if (count < 2 || (reason !== 'manual' && !allow(count))) return false;
  await useExit((position() + 1) % count, reason);
  return true;
};

/**
 * Keeps a new list, and the exit in use if it is still on, or else `use`, or
 * else the first. Says whether the exit in use changed: the song's stream is
 * tied to the exit's address.
 */
const saveExits = async (list: string[], use?: string) => {
  const before = inUse();
  config.set('options.proxyExits', list);
  const active = exits();
  if (active.length === 0) {
    config.set('options.proxyExit', 0);
    const proxy = await startupProxy();
    await session.defaultSession.setProxy(
      proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' },
    );
    return { changed: before !== undefined, inUse: null };
  }
  const target =
    use && active.includes(use)
      ? use
      : before && active.includes(before)
        ? before
        : active[0];
  await useExit(
    active.indexOf(target),
    target === before ? undefined : 'manual',
  );
  return { changed: target !== before, inUse: target };
};

let editor: BrowserWindow | undefined;
// Only the editor may read or change the exits: the music page's bridge
// reaches the same handlers
const fromEditor = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  editor !== undefined &&
  !editor.isDestroyed() &&
  event.sender === editor.webContents;

/** Opens the exits editor, or brings it to the front */
export const openExitsEditor = (parent: BrowserWindow) => {
  if (editor && !editor.isDestroyed()) return editor.focus();
  // Built next to the main process's code by build:exits
  const folder = path.join(import.meta.dirname, '..', 'exits');
  editor = new BrowserWindow({
    parent,
    title: t('main.dialog.proxy-exits.editor.title'),
    width: 780,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: path.join(folder, 'preload.cjs'),
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
  editor.loadFile(path.join(folder, 'index.html'));
};

export const setupProxyExits = () => {
  // The page asks when YouTube distrusts the exit, never to move by hand
  ipcMain.handle('peard:next-exit', (_, reason: unknown) =>
    nextExit(reason === 'refused' ? 'refused' : 'bot-check'),
  );
  ipcMain.handle('peard:exits-load', (event) => {
    if (!fromEditor(event)) throw new Error('Not the exits editor');
    return {
      list: config.get('options.proxyExits') ?? [],
      inUse: inUse() ?? null,
      // Raw, for the editor to fill in
      text: t('main.dialog.proxy-exits.editor', {
        returnObjects: true,
        skipInterpolation: true,
      }),
    };
  });
  ipcMain.handle(
    'peard:exits-save',
    async (event, list: unknown, use: unknown) => {
      if (!fromEditor(event)) throw new Error('Not the exits editor');
      // The editor checked the list; Rien checks it again before it routes
      // traffic through it
      const checked = checkedList(list);
      if (!checked) throw new Error('Not a list of proxy addresses');
      // The editor may close while Rien saves
      const music = editor?.getParentWindow();
      const saved = await saveExits(
        checked,
        typeof use === 'string' ? use : undefined,
      );
      if (saved.changed && music && !music.isDestroyed()) {
        music.webContents.reload();
      }
      return { list: checked, inUse: saved.inUse };
    },
  );
  ipcMain.on('peard:exits-close', (event) => {
    if (fromEditor(event)) editor?.close();
  });
};
