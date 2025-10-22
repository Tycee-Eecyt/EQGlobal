const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eqApi', {
  ready: () => ipcRenderer.invoke('ready'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  updateSettings: (changes) => ipcRenderer.invoke('settings:update', changes),
  selectLogDirectory: () => ipcRenderer.invoke('dialog:select-log-dir'),
  startWatcher: () => ipcRenderer.invoke('watcher:start'),
  stopWatcher: () => ipcRenderer.invoke('watcher:stop'),
  setOverlayClickThrough: (enabled) => ipcRenderer.invoke('overlay:set-click-through', enabled),
  setOverlayOpacity: (opacity) => ipcRenderer.invoke('overlay:set-opacity', opacity),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  loadDefaultTriggers: () => ipcRenderer.invoke('triggers:default'),
  onTimersUpdate: (callback) => {
    const listener = (_event, timers) => callback(timers);
    ipcRenderer.on('timers:update', listener);
    return () => ipcRenderer.removeListener('timers:update', listener);
  },
  onWatcherStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('watcher:status', listener);
    return () => ipcRenderer.removeListener('watcher:status', listener);
  },
  onWatcherLines: (callback) => {
    const listener = (_event, lines) => callback(lines);
    ipcRenderer.on('watcher:lines', listener);
    return () => ipcRenderer.removeListener('watcher:lines', listener);
  },
});
