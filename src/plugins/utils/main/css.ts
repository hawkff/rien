import fs from 'node:fs';

type Unregister = () => void;

let isLoaded = false;

const cssToInject = new Map<
  string,
  ((unregister: Unregister) => void) | undefined
>();
const cssToInjectFile = new Map<
  string,
  ((unregister: Unregister) => void) | undefined
>();
export const injectCSS = async (
  webContents: Electron.WebContents,
  css: string,
): Promise<Unregister> => {
  if (isLoaded) {
    const key = await webContents.insertCSS(css);
    return async () => await webContents.removeInsertedCSS(key);
  }

  return new Promise((resolve) => {
    if (cssToInject.size === 0 && cssToInjectFile.size === 0) {
      setupCssInjection(webContents);
    }
    cssToInject.set(css, resolve);
  });
};

export const injectCSSAsFile = async (
  webContents: Electron.WebContents,
  filepath: string,
): Promise<Unregister> => {
  if (isLoaded) {
    const key = await webContents.insertCSS(fs.readFileSync(filepath, 'utf-8'));
    return async () => await webContents.removeInsertedCSS(key);
  }

  return new Promise((resolve) => {
    if (cssToInject.size === 0 && cssToInjectFile.size === 0) {
      setupCssInjection(webContents);
    }

    cssToInjectFile.set(filepath, resolve);
  });
};

// On the DOM, not on the load event: a page whose images arrive slowly or
// never (a slow proxy) would otherwise go without the app's styles
const setupCssInjection = (webContents: Electron.WebContents) => {
  webContents.on('dom-ready', () => {
    isLoaded = true;

    cssToInject.forEach(async (callback, css) => {
      const key = await webContents.insertCSS(css);
      const remove = async () => await webContents.removeInsertedCSS(key);

      callback?.(remove);
    });

    cssToInjectFile.forEach(async (callback, filepath) => {
      const key = await webContents.insertCSS(
        fs.readFileSync(filepath, 'utf-8'),
      );
      const remove = async () => await webContents.removeInsertedCSS(key);

      callback?.(remove);
    });
  });
};
