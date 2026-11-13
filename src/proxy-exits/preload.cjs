// The exits editor's bridge to Rien: the list, saving it, and closing
// oxlint-disable-next-line typescript/no-require-imports -- a sandboxed preload is a CommonJS script
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('exits', {
  load: () => ipcRenderer.invoke('peard:exits-load'),
  save: (list, use) => ipcRenderer.invoke('peard:exits-save', list, use),
  close: () => ipcRenderer.send('peard:exits-close'),
});
