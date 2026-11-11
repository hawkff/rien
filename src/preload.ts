import { deepmerge } from 'deepmerge-ts';
import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webFrame,
} from 'electron';
import is from 'electron-is';
import { languageResource } from 'virtual:i18n';
import { pluginStubs } from 'virtual:plugins';

import { loadI18n, setLanguage, t } from '@/i18n';
import { isAppPage } from '@/utils/app-page';

import * as config from './config';
import {
  forceLoadPreloadPlugin,
  forceUnloadPreloadPlugin,
  loadAllPreloadPlugins,
} from './loader/preload';

import type { RendererScript } from '@/providers/renderer-scripts';

// @ts-expect-error dummy
globalThis.customElements = { define() {} };

new MutationObserver((mutations, observer) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      const elem = node as HTMLElement;
      if (elem.tagName !== 'SCRIPT') continue;

      const script = elem as HTMLScriptElement;
      if (
        !script.getAttribute('src')?.endsWith('custom-elements-es5-adapter.js')
      )
        continue;

      script.remove();

      observer.disconnect();
      return;
    }
  }
}).observe(document, { subtree: true, childList: true });

const i18nReady = loadI18n().then(async () => {
  await setLanguage(config.get('options.language') ?? 'en');
  await loadAllPreloadPlugins();
});

// Browsers go back and forward with Cmd+Left and Cmd+Right on macOS and with
// Alt elsewhere, but not while the focus is in a text field.
window.addEventListener('keydown', (event) => {
  const modifier = is.macOS() ? event.metaKey : event.altKey;
  const others =
    event.ctrlKey ||
    event.shiftKey ||
    (is.macOS() ? event.altKey : event.metaKey);
  if (!modifier || others) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.composedPath()[0] as HTMLElement;
  if (
    target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  ) {
    return;
  }
  event.preventDefault();
  if (event.key === 'ArrowLeft') history.back();
  else history.forward();
});

// Pages outside the music site, such as Google's sign-in, have nothing that
// leads back to it, so they get a button. It sits in a strip of its own at the
// top, beside the traffic lights on macOS, and the page moves down to make
// room: Google's "unusual traffic" page puts its captcha in the corner the
// button would cover.
if (
  location.protocol === 'https:' &&
  location.hostname !== 'music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com'
) {
  const domReady = new Promise((resolve) =>
    document.addEventListener('DOMContentLoaded', resolve, { once: true }),
  );
  Promise.all([i18nReady, domReady]).then(() => {
    document.documentElement.style.setProperty(
      'padding-top',
      '48px',
      'important',
    );
    const host = document.createElement('div');
    host.dataset.backToMusic = '';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `button {
      position: fixed; z-index: 2147483647; top: 8px; left: ${is.macOS() ? 84 : 16}px;
      padding: 6px 14px; border: 1px solid rgb(128 128 128 / 40%); border-radius: 18px;
      background: #303030; color: #fff; font: 500 14px system-ui, sans-serif;
      cursor: pointer;
    }
    button:hover { background: #454545; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }`;
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: `‹ ${t('main.menu.navigation.submenu.back-to-music')}`,
    });
    button.addEventListener('click', () =>
      ipcRenderer.send('peard:back-to-music'),
    );
    root.append(style, button);
    document.body.append(host);
  });
}

ipcRenderer.on('plugin:unload', async (_, id: string) => {
  await forceUnloadPreloadPlugin(id);
});
ipcRenderer.on('plugin:enable', async (_, id: string) => {
  await forceLoadPreloadPlugin(id);
});

// The bridge and the page script give a page control of the app, so only the
// app's own pages get them. This script also runs for the window's first,
// empty page and for other sites the window shows, such as a sign-in provider.
const appPage = isAppPage(location);
const exposeInMainWorld: typeof contextBridge.exposeInMainWorld = (
  key,
  api,
) => {
  if (appPage) contextBridge.exposeInMainWorld(key, api);
};

exposeInMainWorld('mainConfig', config);
exposeInMainWorld('electronIs', is);
exposeInMainWorld('getLanguageResource', languageResource);
exposeInMainWorld('ipcRenderer', {
  on: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => ipcRenderer.on(channel, listener),
  off: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.off(channel, listener),
  once: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => ipcRenderer.once(channel, listener),
  send: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),
  removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(channel, listener),
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  sendSync: (channel: string, ...args: unknown[]): unknown =>
    ipcRenderer.sendSync(channel, ...args),
  sendToHost: (channel: string, ...args: unknown[]) =>
    ipcRenderer.sendToHost(channel, ...args),
});
exposeInMainWorld('reload', () => ipcRenderer.send('peard:reload'));
exposeInMainWorld('ELECTRON_RENDERER_URL', process.env.ELECTRON_RENDERER_URL);

// Runs in the page first: a registry for the chunks of the page script. A
// chunk runs when it is first required, like a CommonJS module.
const installChunkRegistry = () => {
  type Module = { exports: unknown };
  type Definition = (
    module: Module,
    exports: unknown,
    require: (name: string) => unknown,
  ) => void;
  const definitions = new Map<string, Definition>();
  const modules = new Map<string, Module>();
  const require = (name: string) => {
    const file = name.startsWith('./') ? name.slice(2) : name;
    let module = modules.get(file);
    if (!module) {
      const definition = definitions.get(file);
      if (!definition) throw new Error(`The page chunk ${file} is not loaded`);
      module = { exports: {} };
      modules.set(file, module);
      definition(module, module.exports, require);
    }
    return module.exports;
  };
  const define = (file: string, definition: Definition) => {
    definitions.set(file, definition);
  };
  Object.assign(globalThis, { __pearChunks: { define, require } });
};
const chunkSource = ({ file, url, code }: RendererScript) => ({
  url,
  code: `__pearChunks.define(${JSON.stringify(file)}, function (module, exports, require) {\n${code}\n});`,
});

// Only the chunks of enabled plugins go into the page, so the code of
// disabled plugins is never loaded there.
const pluginConfigs = config.plugins.getPlugins();
const enabledPlugins = Object.entries(pluginStubs)
  .filter(
    ([id, stub]) => deepmerge(stub.config, pluginConfigs[id] ?? {}).enabled,
  )
  .map(([id]) => id);
const renderer = appPage
  ? (ipcRenderer.sendSync('get-renderer-scripts', enabledPlugins) as
      | { dev: string }
      | { entry: string; scripts: RendererScript[] })
  : undefined;
const injected = new Set<string>();
const injectPluginChunks = async (id: string) => {
  if (!renderer || 'dev' in renderer) return;
  const scripts = ipcRenderer.sendSync('get-renderer-plugin-scripts', id, [
    ...injected,
  ]) as RendererScript[];
  if (scripts.length === 0) return;
  await webFrame.executeJavaScriptInIsolatedWorld(0, scripts.map(chunkSource));
  scripts.forEach(({ file }) => injected.add(file));
};
// One injection at a time, so a call never skips chunks that an earlier call
// is still adding.
let injection = Promise.resolve();
exposeInMainWorld('injectRendererPlugin', (id: string) => {
  const result = injection.then(() => injectPluginChunks(id));
  injection = result.catch(() => {});
  return result;
});

let blocked = !!renderer;
if (!renderer) {
  // Not an app page, so there is no page script to wait for.
} else if ('dev' in renderer) {
  webFrame.executeJavaScript(renderer.dev, true, () => (blocked = false));
} else {
  renderer.scripts.forEach(({ file }) => injected.add(file));
  webFrame.executeJavaScriptInIsolatedWorld(
    0,
    [
      { code: `(${installChunkRegistry.toString()})();` },
      ...renderer.scripts.map(chunkSource),
      { code: `__pearChunks.require(${JSON.stringify(renderer.entry)});0` },
    ],
    true,
    () => (blocked = false),
  );
}

// HACK: Wait for the script to be executed
while (blocked);
