// Preload script: exposes only a minimal, allow-listed API to the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ds', {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (cb) => {
      const listener = (_e, v) => cb(v)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    },
  },
  // backend URL and token (known after the main process started the Go backend)
  backend: { info: () => ipcRenderer.invoke('backend:info') },
  // the system "open file" dialog; returns the selected image path or null
  dialog: {
    openEvidence: () => ipcRenderer.invoke('dialog:open-evidence', false),
    openEvidences: () => ipcRenderer.invoke('dialog:open-evidence', true),
    chooseFolder: (defaultPath) => ipcRenderer.invoke('dialog:choose-folder', defaultPath),
  },
  // open a folder / show a file in Explorer
  shell: { show: (p) => ipcRenderer.invoke('shell:show', String(p)) },
  // write plain text to the system clipboard
  clipboard: { writeText: (text) => ipcRenderer.invoke('clipboard:write', String(text)) },
})
