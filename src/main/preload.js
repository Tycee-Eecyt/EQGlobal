const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eqApi', {
  ready: () => ipcRenderer.invoke('ready'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  updateSettings: (changes) => ipcRenderer.invoke('settings:update', changes),
  selectLogDirectory: () => ipcRenderer.invoke('dialog:select-log-dir'),
  startWatcher: () => ipcRenderer.invoke('watcher:start'),
  stopWatcher: () => ipcRenderer.invoke('watcher:stop'),
  setOverlayClickThrough: (target, enabled) => ipcRenderer.invoke('overlay:set-click-through', target, enabled),
  setOverlayOpacity: (opacity) => ipcRenderer.invoke('overlay:set-opacity', opacity),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showMobOverlay: () => ipcRenderer.invoke('overlay:show-mobs'),
  hideMobOverlay: () => ipcRenderer.invoke('overlay:hide-mobs'),
  setOverlayMoveMode: (enabled) => ipcRenderer.invoke('overlay:move-mode', enabled),
  getOverlayMoveMode: () => ipcRenderer.invoke('overlay:get-move-mode'),
  resizeOverlay: (edge, dx, dy) => ipcRenderer.invoke('overlay:resize', { edge, dx, dy }),
  loadDefaultTriggers: () => ipcRenderer.invoke('triggers:default'),
  importGinaGtp: () => ipcRenderer.invoke('triggers:import-gtp'),
  exportTriggers: (triggers) => ipcRenderer.invoke('triggers:export', triggers),
  selectSoundFile: () => ipcRenderer.invoke('dialog:select-sound-file'),
  getMobWindows: () => ipcRenderer.invoke('mob-windows:get'),
  getMobWindowDefinitions: () => ipcRenderer.invoke('mob-windows:definitions'),
  recordMobKill: (mobId, timestamp) => ipcRenderer.invoke('mob-windows:record-kill', mobId, timestamp),
  clearMobKill: (mobId) => ipcRenderer.invoke('mob-windows:clear', mobId),
  getAuthState: () => ipcRenderer.invoke('auth:status'),
  login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onAuthChanged: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, auth) => callback(auth);
    ipcRenderer.on('auth:changed', listener);
    return () => ipcRenderer.removeListener('auth:changed', listener);
  },
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
  onOverlayMoveMode: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('overlay:move-mode', listener);
    return () => ipcRenderer.removeListener('overlay:move-mode', listener);
  },
  onMobWindowsUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('mob-windows:update', listener);
    return () => ipcRenderer.removeListener('mob-windows:update', listener);
  },
});
