const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  getVersion: () => ipcRenderer.invoke('desktop:version'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
});
