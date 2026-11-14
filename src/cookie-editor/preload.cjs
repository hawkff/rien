// The cookie editor's bridge to Rien: the cookies without their values,
// removing, copying, signing in with a paste, and closing
// oxlint-disable-next-line typescript/no-require-imports -- a sandboxed preload is a CommonJS script
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cookies', {
  load: () => ipcRenderer.invoke('peard:cookies-load'),
  remove: (name, domain, path) =>
    ipcRenderer.invoke('peard:cookies-remove', name, domain, path),
  removeAll: () => ipcRenderer.invoke('peard:cookies-remove-all'),
  copy: (format) => ipcRenderer.invoke('peard:cookies-export', format),
  signIn: (text) => ipcRenderer.invoke('peard:cookies-sign-in', text),
  close: () => ipcRenderer.send('peard:cookies-close'),
  // Google's sign-in asks an open editor for its paste box
  /** @param {(view: string) => void} show */
  onView: (show) => {
    ipcRenderer.on('peard:cookies-view', (_, view) => show(String(view)));
  },
});
