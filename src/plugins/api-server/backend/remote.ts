// Rien's window in a browser: the window's screencast goes to the viewers'
// pages, and their mouse and keys come back as the window's input. A link's
// key lets a page in; a pairing code lets ytmpc in where Rien has no window
// to ask in.
import { randomBytes } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { isHeadless } from '@/providers/headless';
import {
  linkHost,
  sameSecret,
  viewSize,
  type ViewerMessage,
} from '@/utils/remote-view';

import type { APIServerConfig } from '../config';

export type Viewer = {
  send: (text: string) => void;
  /** Whether frames pile up on the way to the viewer */
  behind: () => boolean;
  close: () => void;
};
const viewers = new Set<Viewer>();
// Stops the window's screencast; set by remoteView
let detach = () => {};

/** Closes the pages that show the window, and stops sending it to them */
export const dropViewers = () => {
  for (const viewer of viewers) {
    viewers.delete(viewer);
    viewer.close();
  }
  detach();
};

let viewKey = '';
/** A link to the window with a new key; older links stop working */
export const newViewLink = (host: string, https: boolean) => {
  viewKey = randomBytes(18).toString('base64url');
  // Pages opened with an older link lose the window too
  dropViewers();
  // After # the key stays in the browser: no request carries it
  return `${https ? 'https' : 'http'}://${host}/remote#${viewKey}`;
};
export const isViewKey = (given: unknown) => sameSecret(given, viewKey);

let pairingCode = '';
const pairingFile = () => path.join(app.getPath('userData'), 'pairing-code');
/** A new code for ytmpc, in a file only this user can read */
export const newPairingCode = () => {
  pairingCode = randomBytes(16).toString('hex');
  writeFileSync(pairingFile(), pairingCode, { mode: 0o600 });
  // A file that was there before keeps its mode otherwise
  chmodSync(pairingFile(), 0o600);
};
/** Rien with a window asks in a dialog instead */
export const dropPairingCode = () => rmSync(pairingFile(), { force: true });
/** Whether `given` is the pairing code; each code works once */
export const takePairingCode = (given: unknown) => {
  if (!sameSecret(given, pairingCode)) return false;
  newPairingCode();
  return true;
};

/** What Rien without a window says when it starts */
export const greet = (config: APIServerConfig) => {
  const link = newViewLink(
    linkHost(config.hostname, config.port),
    config.useHttps,
  );
  console.log(
    [
      "Rien runs without a window. Open this link in a browser to see Rien's window, sign in, or answer the site:",
      link,
      `From another computer, forward the port first: ssh -L ${config.port}:127.0.0.1:${config.port} THIS-COMPUTER`,
      'ytmpc gets in by itself when the same user runs it on this computer. ytmpc signin gives a new link.',
    ].join('\n'),
  );
  // A terminal also puts the link on its clipboard (OSC 52), over SSH too
  if (process.stdout.isTTY) {
    process.stdout.write(
      `\x1b]52;c;${Buffer.from(link).toString('base64')}\x07`,
    );
  }
};

type Frame = { data: string; width: number; height: number };
type ScreencastFrame = {
  sessionId: number;
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number };
};

export const remoteView = (win: BrowserWindow) => {
  const debug = win.webContents.debugger;
  detach = () => {
    if (debug.isAttached()) debug.detach();
  };
  const command = (method: string, params?: object) =>
    debug.sendCommand(method, params);
  const send = (viewer: Viewer, frame: Frame) =>
    viewer.send(JSON.stringify({ type: 'frame', ...frame }));
  debug.on('message', (_event, method, params: ScreencastFrame) => {
    if (method !== 'Page.screencastFrame') return;
    command('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(
      () => {},
    );
    const { deviceWidth: width, deviceHeight: height } = params.metadata;
    for (const viewer of viewers) {
      // A slow viewer skips frames: the next one shows the window as it is
      if (!viewer.behind()) send(viewer, { data: params.data, width, height });
    }
  });

  return {
    async join(viewer: Viewer, width: number, height: number) {
      viewers.add(viewer);
      // The window fits the viewer's page; a window on a screen keeps its size
      if (isHeadless()) win.setContentSize(...viewSize(width, height));
      if (!debug.isAttached()) {
        debug.attach('1.3');
        await command('Page.startScreencast', {
          format: 'jpeg',
          quality: 80,
          maxWidth: 2560,
          maxHeight: 1600,
        });
      }
      // The screencast sends a frame when the page changes: the page as it
      // is now comes first
      const [contentWidth, contentHeight] = win.getContentSize();
      const { data } = (await command('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 80,
      })) as { data: string };
      send(viewer, { data, width: contentWidth, height: contentHeight });
    },
    leave(viewer: Viewer) {
      viewers.delete(viewer);
      if (viewers.size === 0) detach();
    },
    async input(viewer: Viewer, message: ViewerMessage) {
      if (!viewers.has(viewer) || !debug.isAttached()) return;
      switch (message.type) {
        case 'size': {
          if (isHeadless()) {
            win.setContentSize(...viewSize(message.width, message.height));
          }
          return;
        }
        case 'mouse': {
          const { event, ...rest } = message;
          await command('Input.dispatchMouseEvent', { ...rest, type: event });
          return;
        }
        case 'key': {
          const { event, keyCode, ...rest } = message;
          await command('Input.dispatchKeyEvent', {
            ...rest,
            type: event,
            windowsVirtualKeyCode: keyCode,
          });
          return;
        }
        case 'text': {
          await command('Input.insertText', { text: message.text });
          return;
        }
        case 'hello':
          return;
      }
    },
  };
};
