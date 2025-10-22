const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const LogWatcher = require('./logWatcher');
const TimerManager = require('./timerManager');
const defaultTriggers = require('../shared/defaultTriggers.json');

require('dotenv').config();

let mainWindow;
let overlayWindow;
let logWatcher;
let settingsPath;

const timerManager = new TimerManager();
timerManager.on('update', (timers) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timers:update', timers);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('timers:update', timers);
  }
});

const backendQueue = {
  lines: [],
  events: [],
};
let backendFlushTimer = null;

const defaultSettings = {
  logDirectory: process.env.EQ_LOG_DIR || '',
  backendUrl: process.env.BACKEND_URL || '',
  overlayClickThrough: false,
  overlayOpacity: 0.85,
  overlayBounds: null,
  triggers: defaultTriggers,
};

let settings = { ...defaultSettings };
let overlayBoundsSaveTimer = null;
let overlayMoveMode = false;

function resolveRendererPath(fileName) {
  return path.join(__dirname, '..', 'renderer', fileName);
}

async function ensureSettingsLoaded() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const diskSettings = await readSettingsFromDisk(settingsPath);
    settings = {
      ...defaultSettings,
      ...diskSettings,
      triggers: diskSettings.triggers && diskSettings.triggers.length > 0 ? diskSettings.triggers : defaultSettings.triggers,
    };
  }

  return settings;
}

async function readSettingsFromDisk(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

async function saveSettings(updatedSettings = settings) {
  if (!settingsPath) {
    return;
  }

  try {
    await fs.promises.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to persist settings', error);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(resolveRendererPath('index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  const baseBounds = { width: 320, height: 360 };
  const saved = settings.overlayBounds || {};
  const windowOptions = {
    width: Number(saved.width) || baseBounds.width,
    height: Number(saved.height) || baseBounds.height,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#00000000',
  };

  // Only apply x/y if present; Electron will pick a default otherwise
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    windowOptions.x = saved.x;
    windowOptions.y = saved.y;
  }

  overlayWindow = new BrowserWindow(windowOptions);

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(resolveRendererPath('overlay.html'));
  overlayWindow.setOpacity(settings.overlayOpacity);
  overlayWindow.setIgnoreMouseEvents(
    overlayMoveMode ? false : Boolean(settings.overlayClickThrough),
    { forward: true }
  );

  const scheduleSaveOverlayBounds = () => {
    if (overlayBoundsSaveTimer) {
      clearTimeout(overlayBoundsSaveTimer);
    }
    overlayBoundsSaveTimer = setTimeout(async () => {
      overlayBoundsSaveTimer = null;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        const b = overlayWindow.getBounds();
        settings.overlayBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        await saveSettings(settings);
      }
    }, 300);
  };

  overlayWindow.on('move', scheduleSaveOverlayBounds);
  overlayWindow.on('resize', scheduleSaveOverlayBounds);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watcher:status', status);
  }
}

async function startWatcher() {
  if (logWatcher) {
    return;
  }

  const activeSettings = await ensureSettingsLoaded();
  if (!activeSettings.logDirectory) {
    throw new Error('EverQuest log directory is not configured.');
  }

  logWatcher = new LogWatcher(activeSettings.logDirectory, activeSettings.triggers);

  logWatcher.on('trigger', handleTriggerMatch);
  logWatcher.on('lines', handleNewLines);
  logWatcher.on('status', sendStatus);
  logWatcher.on('error', (error) => {
    console.error('Log watcher error:', error);
    sendStatus({ state: 'error', message: error.message });
  });

  await logWatcher.start();
  sendStatus({ state: 'watching', directory: activeSettings.logDirectory });
}

async function stopWatcher() {
  if (!logWatcher) {
    return;
  }

  await logWatcher.stop();
  logWatcher.removeAllListeners();
  logWatcher = null;
  timerManager.stop();
  sendStatus({ state: 'stopped' });
}

function handleTriggerMatch(payload) {
  const timer = timerManager.addTimer(payload);
  queueBackendEvent(payload, timer);
}

function handleNewLines({ filePath, lines }) {
  const decoratedLines = lines.map((line) => {
    const timestampMatch = line.match(/^\[(.+?)\]/);
    const timestamp = timestampMatch ? new Date(timestampMatch[1]) : new Date();
    return {
      filePath,
      line,
      timestamp: timestamp.toISOString(),
    };
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watcher:lines', decoratedLines);
  }

  backendQueue.lines.push(...decoratedLines);
  scheduleBackendFlush();
}

function queueBackendEvent(payload, timer) {
  const { trigger, line, filePath, timestamp } = payload;
  backendQueue.events.push({
    triggerId: trigger.id,
    label: trigger.label,
    duration: trigger.duration,
    color: trigger.color,
    filePath,
    line,
    timer,
    timestamp: (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString(),
  });

  scheduleBackendFlush();
}

function scheduleBackendFlush() {
  if (backendFlushTimer) {
    return;
  }

  backendFlushTimer = setTimeout(async () => {
    backendFlushTimer = null;
    await flushBackend();
  }, 1500);
}

async function flushBackend() {
  const baseUrl = (settings.backendUrl || '').trim();
  if (!baseUrl) {
    backendQueue.lines.length = 0;
    backendQueue.events.length = 0;
    return;
  }

  const payloadLines = backendQueue.lines.splice(0, backendQueue.lines.length);
  const payloadEvents = backendQueue.events.splice(0, backendQueue.events.length);

  const requests = [];

  if (payloadLines.length > 0) {
    requests.push(
      axios
        .post(joinBackendUrl(baseUrl, '/api/log-lines'), { lines: payloadLines })
        .catch((error) => {
          console.error('Failed to push log lines', error.message);
        })
    );
  }

  if (payloadEvents.length > 0) {
    requests.push(
      axios
        .post(joinBackendUrl(baseUrl, '/api/log-events'), { events: payloadEvents })
        .catch((error) => {
          console.error('Failed to push log events', error.message);
        })
    );
  }

  await Promise.all(requests);
}

function joinBackendUrl(base, suffix) {
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
    return url.toString();
  } catch (error) {
    return `${base.replace(/\/$/, '')}${suffix}`;
  }
}

function registerIpcHandlers() {
  ipcMain.handle('ready', async () => ensureSettingsLoaded());

  ipcMain.handle('settings:load', async () => ensureSettingsLoaded());

  ipcMain.handle('settings:update', async (_event, partialSettings) => {
    await ensureSettingsLoaded();
    settings = {
      ...settings,
      ...partialSettings,
    };

    if (partialSettings.triggers && logWatcher) {
      logWatcher.setTriggers(settings.triggers);
    }

    if (partialSettings.logDirectory && logWatcher) {
      await stopWatcher();
      await startWatcher();
    }

    await saveSettings(settings);
    return settings;
  });

  ipcMain.handle('dialog:select-log-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select EverQuest Logs Folder',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const directory = result.filePaths[0];
    settings.logDirectory = directory;
    await saveSettings(settings);
    if (logWatcher) {
      await stopWatcher();
      await startWatcher();
    }
    return directory;
  });

  ipcMain.handle('watcher:start', async () => {
    await startWatcher();
    return { status: 'watching', directory: settings.logDirectory };
  });

  ipcMain.handle('watcher:stop', async () => {
    await stopWatcher();
    return { status: 'stopped' };
  });

  ipcMain.handle('overlay:set-click-through', async (_event, enabled) => {
    settings.overlayClickThrough = Boolean(enabled);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(overlayMoveMode ? false : settings.overlayClickThrough, { forward: true });
    }
    await saveSettings(settings);
    return settings.overlayClickThrough;
  });

  ipcMain.handle('overlay:set-opacity', async (_event, opacity) => {
    const nextOpacity = Math.min(1, Math.max(0.2, Number(opacity) || settings.overlayOpacity));
    settings.overlayOpacity = nextOpacity;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(nextOpacity);
    }
    await saveSettings(settings);
    return nextOpacity;
  });

  ipcMain.handle('overlay:show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
    }
    return true;
  });

  ipcMain.handle('overlay:hide', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
    return true;
  });

  ipcMain.handle('overlay:move-mode', async (_event, enabled) => {
    overlayMoveMode = Boolean(enabled);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(overlayMoveMode ? false : Boolean(settings.overlayClickThrough), { forward: true });
      if (overlayMoveMode) {
        overlayWindow.showInactive();
      }
      overlayWindow.webContents.send('overlay:move-mode', overlayMoveMode);
    }
    return overlayMoveMode;
  });

  ipcMain.handle('overlay:get-move-mode', () => overlayMoveMode);

  ipcMain.handle('triggers:default', () => defaultTriggers);
}

app.whenReady().then(async () => {
  await ensureSettingsLoaded();
  createMainWindow();
  createOverlayWindow();
  registerIpcHandlers();

  if (app.isPackaged) {
    // In packaged builds, default to watching automatically if configured.
    if (settings.logDirectory) {
      startWatcher().catch((error) => console.error('Failed to start watcher on boot', error));
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      if (!overlayWindow) {
        createOverlayWindow();
      }
    }
  });
});

app.on('before-quit', async () => {
  if (backendFlushTimer) {
    clearTimeout(backendFlushTimer);
    backendFlushTimer = null;
    await flushBackend();
  }
  await stopWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
