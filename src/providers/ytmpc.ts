// ytmpc, Rien's terminal client, ships inside the app. This puts a command
// for it where a shell finds it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, type BrowserWindow, dialog } from 'electron';

import { t } from '@/i18n';
import { placeCommand } from '@/utils/place-command';

const run = promisify(execFile);

// On macOS every shell looks in /usr/local/bin, which only an administrator
// can write to on most Macs: then the system asks for the password
const placeOnMac = async (binary: string) => {
  const target = '/usr/local/bin/ytmpc';
  try {
    placeCommand(binary, target, false);
  } catch {
    const script = `on run argv
do shell script "mkdir -p /usr/local/bin && rm -f ${target}.partial && ln -s " & quoted form of (item 1 of argv) & " ${target}.partial && mv -f ${target}.partial ${target}" with administrator privileges
end run`;
    await run('osascript', ['-e', script, binary]);
  }
  return target;
};

export const installYtmpc = async (win: BrowserWindow) => {
  // The packer puts the binary for the packed architecture here
  const binary = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'dist',
    'bin',
    process.arch,
    'ytmpc',
  );
  if (!app.isPackaged || !existsSync(binary)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: t('main.dialog.ytmpc.missing'),
    });
    return;
  }
  // Flatpak and Snap keep the app's files and the home folder from the shell
  if (process.env.FLATPAK_ID || process.env.SNAP) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: t('main.dialog.ytmpc.sandbox'),
    });
    return;
  }
  // A link to an app that runs from its download (macOS moves it to a
  // passing place) or from the disk image would stop working
  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: t('main.dialog.ytmpc.applications'),
    });
    return;
  }
  // An AppImage's files live in a mount that goes away when Rien quits
  const copy = Boolean(process.env.APPIMAGE);
  try {
    let target = path.join(homedir(), '.local', 'bin', 'ytmpc');
    if (process.platform === 'darwin') target = await placeOnMac(binary);
    else placeCommand(binary, target, copy);
    await dialog.showMessageBox(win, {
      type: 'info',
      message: t('main.dialog.ytmpc.done', { path: target }),
      detail: [
        t(copy ? 'main.dialog.ytmpc.copy' : 'main.dialog.ytmpc.link'),
        process.platform === 'darwin' ? '' : t('main.dialog.ytmpc.local-bin'),
        t('main.dialog.ytmpc.api-server'),
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    // osascript's answer when the password prompt is cancelled
    if (String(error).includes('(-128)')) return;
    await dialog.showMessageBox(win, {
      type: 'error',
      message: t('main.dialog.ytmpc.failed'),
      detail: String(error),
    });
  }
};
