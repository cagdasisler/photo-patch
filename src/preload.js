'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openImage: () => ipcRenderer.invoke('open-image'),
  startupImage: () => ipcRenderer.invoke('startup-image'),
  chooseSavePath: (suggestedPath) => ipcRenderer.invoke('choose-save-path', suggestedPath),
  writeFile: (filePath, bytes) => ipcRenderer.invoke('write-file', filePath, bytes),
  setDirty: (value) => ipcRenderer.send('set-dirty', value),
  setTitleBarColors: (color, symbolColor) => ipcRenderer.send('set-title-bar-colors', color, symbolColor),
  loadSignatures: () => ipcRenderer.invoke('load-signatures'),
  saveSignatures: (list) => ipcRenderer.invoke('save-signatures', list),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
