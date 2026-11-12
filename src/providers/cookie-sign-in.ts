// Signs the window in with cookies pasted from a browser that is signed in.
// Google's sign-in inside the app can't use passkeys, which need a browser.
import prompt from 'custom-electron-prompt';
import { type BrowserWindow, dialog } from 'electron';

import { t } from '@/i18n';
import { isAppPage } from '@/utils/app-page';
import { parsePastedCookies, signedIn } from '@/utils/pasted-cookies';

import { restart } from './app-controls';
import promptOptions from './prompt-options';

export const signInWithCookies = async (win: BrowserWindow) => {
  // The box shows one line of plain text, so the longer text goes in as HTML
  const paragraph = (key: string) =>
    `<p>${t(key).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`;
  const text = await prompt(
    {
      title: t('main.dialog.cookies.title'),
      label: `<div style="white-space: normal; text-align: left">${['label', 'formats', 'warning'].map((key) => paragraph(`main.dialog.cookies.${key}`)).join('')}</div>`,
      useHtmlLabel: true,
      height: 330,
      type: 'input',
      // They open the account to anyone who sees them
      inputAttrs: {
        type: 'password',
        placeholder: t('main.dialog.cookies.placeholder'),
      },
      width: 560,
      ...promptOptions(),
    },
    win,
  );
  if (!text) return;
  const cookies = parsePastedCookies(text);
  const problem =
    cookies.length === 0
      ? t('main.dialog.cookies.unreadable')
      : !signedIn(cookies) && t('main.dialog.cookies.signed-out');
  if (problem) {
    await dialog.showMessageBox(win, { type: 'error', message: problem });
    return;
  }
  const jar = win.webContents.session.cookies;
  // The pasted account replaces the one signed in, so no two sessions mix
  const old = (await jar.get({})).map(({ domain, path, name }) => ({
    hostname: (domain ?? '').replace(/^\./, ''),
    path: path ?? '/',
    name,
  }));
  await Promise.allSettled(
    old
      .filter(({ hostname }) => isAppPage({ protocol: 'https:', hostname }))
      .map(({ hostname, path, name }) =>
        jar.remove(`https://${hostname}${path}`, name),
      ),
  );
  const results = await Promise.allSettled(
    cookies.map((cookie) => jar.set(cookie)),
  );
  await jar.flushStore();
  const failed = results.filter(({ status }) => status === 'rejected').length;
  if (failed > 0) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: t('main.dialog.cookies.partly', {
        failed,
        count: cookies.length,
      }),
    });
  }
  // A restart, so that parts which copied the old cookies at start, such as
  // the downloader, get the new ones too
  restart();
};
