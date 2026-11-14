// Rien without a display, on Linux: Chromium's headless platform. The window
// then exists only in memory: ytmpc controls Rien through the API server, and
// the API server's remote view shows the window in a browser.
import { app, dialog, type MessageBoxOptions } from 'electron';

import * as config from '@/config';
import { LoggerPrefix } from '@/utils';

/** Chromium picks its platform before Rien's code runs, so the command line has to name it */
export const HEADLESS = '--ozone-platform=headless';

export const isHeadless = () =>
  process.platform === 'linux' &&
  app.commandLine.getSwitchValue('ozone-platform') === 'headless';

/** Before the plugins load: ytmpc's way in, and dialogs that need no display */
export const setupHeadless = () => {
  config.plugins.setOptions('api-server', { enabled: true }, []);
  // A message box needs a display: it goes to the log, and a question gets
  // the answer Electron gives a closed box: its cancel button, else the first
  // button labeled Cancel or No, else the first
  const answer = (options: MessageBoxOptions) => {
    const response =
      options.cancelId ??
      Math.max(
        0,
        options.buttons?.findIndex((label) => /^(cancel|no)$/i.test(label)) ??
          0,
      );
    const reply =
      (options.buttons?.length ?? 0) > 1
        ? ` (answered "${options.buttons?.[response]}": no window to ask in)`
        : '';
    console.log(
      LoggerPrefix,
      [options.message, options.detail].filter(Boolean).join(' ') + reply,
    );
    return { response, checkboxChecked: false };
  };
  Object.assign(dialog, {
    showMessageBox: (...args: unknown[]) =>
      Promise.resolve(answer(args.at(-1) as MessageBoxOptions)),
    showMessageBoxSync: (...args: unknown[]) =>
      answer(args.at(-1) as MessageBoxOptions).response,
    showErrorBox: (title: string, content: string) =>
      console.error(LoggerPrefix, title, content),
  });
};
