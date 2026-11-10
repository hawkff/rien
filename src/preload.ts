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

import { loadI18n, setLanguage } from '@/i18n';

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

loadI18n().then(async () => {
  await setLanguage(config.get('options.language') ?? 'en');
  await loadAllPreloadPlugins();
});

ipcRenderer.on('plugin:unload', async (_, id: string) => {
  await forceUnloadPreloadPlugin(id);
});
ipcRenderer.on('plugin:enable', async (_, id: string) => {
  await forceLoadPreloadPlugin(id);
});

contextBridge.exposeInMainWorld('mainConfig', config);
contextBridge.exposeInMainWorld('electronIs', is);
contextBridge.exposeInMainWorld('getLanguageResource', languageResource);
contextBridge.exposeInMainWorld('ipcRenderer', {
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
contextBridge.exposeInMainWorld('reload', () =>
  ipcRenderer.send('peard:reload'),
);
contextBridge.exposeInMainWorld(
  'ELECTRON_RENDERER_URL',
  process.env.ELECTRON_RENDERER_URL,
);

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
const renderer = ipcRenderer.sendSync(
  'get-renderer-scripts',
  enabledPlugins,
) as { dev: string } | { entry: string; scripts: RendererScript[] };
const injected = new Set<string>();
const injectPluginChunks = async (id: string) => {
  if ('dev' in renderer) return;
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
contextBridge.exposeInMainWorld('injectRendererPlugin', (id: string) => {
  const result = injection.then(() => injectPluginChunks(id));
  injection = result.catch(() => {});
  return result;
});

let blocked = true;
if ('dev' in renderer) {
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
