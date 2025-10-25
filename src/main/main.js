const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const axios = require('axios');
const childProcess = require('child_process');
const LogWatcher = require('./logWatcher');
const TimerManager = require('./timerManager');
const MobWindowManager = require('./mobWindowManager');
const defaultTriggers = require('../shared/defaultTriggers.json');
const mobWindowDefinitions = require('../shared/mobWindows.json');

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const APP_ICON_FILENAME = 'EQ-Global-logo.png';
const TRAY_ICON_FILENAME = 'EQ-Global-logo-transparent.png';

function resolveAssetPath(fileName) {
  return path.join(ASSETS_DIR, fileName);
}

function loadAssetImage(fileName, resize) {
  try {
    const fullPath = resolveAssetPath(fileName);
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    let image = nativeImage.createFromPath(fullPath);
    if (!image || image.isEmpty()) {
      return null;
    }
    if (resize && resize.width && resize.height) {
      image = image.resize({ width: resize.width, height: resize.height, quality: 'best' });
    }
    return image && !image.isEmpty() ? image : null;
  } catch (error) {
    console.error(`Failed to load asset image "${fileName}"`, error);
    return null;
  }
}

require('dotenv').config();

let mainWindow;
let overlayWindow;
let mobOverlayWindow;
let logWatcher;
let settingsPath;
let tray;

const timerManager = new TimerManager();
timerManager.on('update', (timers) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timers:update', timers);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('timers:update', timers);
  }
});

const mobWindowManager = new MobWindowManager(mobWindowDefinitions, { tickRateMs: 30_000 });
mobWindowManager.on('update', (snapshot) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mob-windows:update', snapshot);
  }
  if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
    mobOverlayWindow.webContents.send('mob-windows:update', snapshot);
  }
});
mobWindowManager.start();

const backendQueue = {
  lines: [],
  events: [],
};
let backendFlushTimer = null;

const defaultSettings = {
  logDirectory: process.env.EQ_LOG_DIR || '',
  backendUrl: process.env.BACKEND_URL || '',
  overlayClickThroughTimers: false,
  overlayClickThroughMobs: false,
  overlayOpacity: 0.85,
  overlayBounds: null,
  mobOverlayBounds: null,
  categories: [],
  triggers: defaultTriggers,
  mobWindows: {
    kills: {},
  },
};

let settings = { ...defaultSettings };
let overlayBoundsSaveTimer = null;
let mobOverlayBoundsSaveTimer = null;
let overlayMoveMode = false;

function createFallbackTrayIconImage() {
  const logicalSize = process.platform === 'darwin' ? 22 : 16;
  const scaleFactor = 2;
  const size = logicalSize * scaleFactor;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.45;
  const borderRadius = radius - Math.max(2, size * 0.08);
  const innerHighlight = borderRadius * 0.45;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (distance > radius) {
        continue;
      }

      let r;
      let g;
      let b;

      if (distance >= borderRadius) {
        r = 12;
        g = 74;
        b = 112;
      } else if (distance <= innerHighlight) {
        const falloff = 1 - distance / Math.max(innerHighlight, 1);
        r = Math.round(228 + 20 * falloff);
        g = Math.round(240 + 10 * falloff);
        b = 255;
      } else {
        const t = (distance - innerHighlight) / Math.max(borderRadius - innerHighlight, 1);
        const baseR = 20;
        const baseG = 164;
        const baseB = 244;
        const gradient = 1 - t * 0.35;
        const verticalBias = 1 + ((center - y) / size) * 0.18;
        const horizontalBias = 1 + ((center - x) / size) * 0.06;
        const scale = gradient * verticalBias * horizontalBias;
        r = Math.min(255, Math.round(baseR * scale + 20));
        g = Math.min(255, Math.round(baseG * scale + 26));
        b = Math.min(255, Math.round(baseB * scale + 38));

        if (distance <= innerHighlight * 1.25) {
          r = Math.min(255, r + 12);
          g = Math.min(255, g + 18);
          b = Math.min(255, b + 20);
        }
      }

      buffer[idx] = b;
      buffer[idx + 1] = g;
      buffer[idx + 2] = r;
      buffer[idx + 3] = 255;
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor });
  image.setTemplateImage(process.platform === 'darwin');
  return image;
}

function createTrayIconImage() {
  const size = process.platform === 'darwin' ? 22 : 18;
  const desired = loadAssetImage(TRAY_ICON_FILENAME, { width: size, height: size });
  if (desired) {
    if (process.platform === 'darwin') {
      desired.setTemplateImage(false);
    }
    return desired;
  }
  return createFallbackTrayIconImage();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const mainWindowExists = mainWindow && !mainWindow.isDestroyed();
  const mainVisible = Boolean(mainWindowExists && mainWindow.isVisible());
  const overlayExists = overlayWindow && !overlayWindow.isDestroyed();
  const overlayVisible = Boolean(overlayExists && overlayWindow.isVisible());
  const mobOverlayExists = mobOverlayWindow && !mobOverlayWindow.isDestroyed();
  const mobOverlayVisible = Boolean(mobOverlayExists && mobOverlayWindow.isVisible());

  const template = [
    {
      label: mainVisible ? 'Hide EQGlobal' : 'Show EQGlobal',
      click: () => {
        toggleMainWindowVisibility();
      },
    },
    {
      label: overlayVisible ? 'Hide Timer Overlay' : 'Show Timer Overlay',
      click: () => {
        toggleOverlayVisibility();
      },
    },
    {
      label: mobOverlayVisible ? 'Hide Mob Overlay' : 'Show Mob Overlay',
      click: () => {
        toggleMobOverlayVisibility();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit EQGlobal',
      click: () => {
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function ensureTray() {
  if (tray) {
    updateTrayMenu();
    return tray;
  }

  tray = new Tray(createTrayIconImage());
  tray.setToolTip('EQGlobal');
  if (typeof tray.setIgnoreDoubleClickEvents === 'function') {
    tray.setIgnoreDoubleClickEvents(true);
  }
  tray.on('click', () => {
    showMainWindowFromTray();
  });
  tray.on('right-click', () => {
    updateTrayMenu();
  });
  updateTrayMenu();
  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function showMainWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  }
  updateTrayMenu();
}

function toggleMainWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    updateTrayMenu();
    return;
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindowFromTray();
  }
  updateTrayMenu();
}

function toggleOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    updateTrayMenu();
    return;
  }

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.showInactive();
  }
  updateTrayMenu();
}

function toggleMobOverlayVisibility() {
  if (!mobOverlayWindow || mobOverlayWindow.isDestroyed()) {
    createMobOverlayWindow();
  }

  if (!mobOverlayWindow || mobOverlayWindow.isDestroyed()) {
    updateTrayMenu();
    return;
  }

  if (mobOverlayWindow.isVisible()) {
    mobOverlayWindow.hide();
  } else {
    if (typeof mobOverlayWindow.isMinimized === 'function' && mobOverlayWindow.isMinimized()) {
      mobOverlayWindow.restore();
    }
    mobOverlayWindow.showInactive();
  }
  updateTrayMenu();
}

function minimizeMobOverlayWindow() {
  if (!mobOverlayWindow || mobOverlayWindow.isDestroyed()) {
    return;
  }
  if (typeof mobOverlayWindow.minimize === 'function' && !mobOverlayWindow.isMinimized()) {
    mobOverlayWindow.minimize();
  } else {
    mobOverlayWindow.hide();
  }
  updateTrayMenu();
}

const CATEGORY_COLOR_MAP = {
  'AoEs': '#f06595',
  'Complete Heals': '#ffd93d',
  'Cures': '#6bcff6',
  'Death Touches': '#ff6b6b',
  'Enrage': '#f06595',
  'Gating': '#845ef7',
  'Rampage': '#ffa94d',
  'Mob Spells': '#74c0fc',
};

function hashStringDjb2(str = '') {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorFromCategory(category) {
  if (!category) return null;
  const mapped = CATEGORY_COLOR_MAP[category] || CATEGORY_COLOR_MAP[category.trim()];
  if (mapped) return mapped;
  const h = hashStringDjb2(category) % 360;
  const s = 65;
  const l = 55;
  // Convert HSL to hex
  function hslToRgb(hh, ss, ll) {
    ss /= 100; ll /= 100;
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r=0,g=0,b=0;
    if (0 <= hh && hh < 60) { r=c; g=x; b=0; }
    else if (60 <= hh && hh < 120) { r=x; g=c; b=0; }
    else if (120 <= hh && hh < 180) { r=0; g=c; b=x; }
    else if (180 <= hh && hh < 240) { r=0; g=x; b=c; }
    else if (240 <= hh && hh < 300) { r=x; g=0; b=c; }
    else { r=c; g=0; b=x; }
    const to255 = (v) => Math.round((v + m) * 255);
    return [to255(r), to255(g), to255(b)];
  }
  const [r,g,b] = hslToRgb(h, s, l);
  const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  return hex;
}

function applyCategoryColors(list = []) {
  return list.map((t) => {
    const out = { ...t };
    if (!out.color || !/^#?[0-9a-f]{6}$/i.test(String(out.color))) {
      const catColor = colorFromCategory(out.category);
      if (catColor) {
        out.color = catColor;
      } else if (!out.color) {
        out.color = '#00c9ff';
      }
    } else if (out.color && !out.color.startsWith('#')) {
      out.color = `#${out.color}`;
    }
    return out;
  });
}

function runPowerShellConverter(scriptPath, inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-InputPath', inputPath, '-OutputPath', outputPath];
    const child = childProcess.spawn(ps, args, { windowsHide: true });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr || `Converter exited with code ${code}`));
    });
  });
}

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
    if (typeof settings.overlayClickThroughTimers !== 'boolean') {
      if (diskSettings && typeof diskSettings.overlayClickThrough === 'boolean') {
        settings.overlayClickThroughTimers = Boolean(diskSettings.overlayClickThrough);
      } else {
        settings.overlayClickThroughTimers = defaultSettings.overlayClickThroughTimers;
      }
    }
    if (typeof settings.overlayClickThroughMobs !== 'boolean') {
      if (diskSettings && typeof diskSettings.overlayClickThrough === 'boolean') {
        settings.overlayClickThroughMobs = Boolean(diskSettings.overlayClickThrough);
      } else {
        settings.overlayClickThroughMobs = defaultSettings.overlayClickThroughMobs;
      }
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'overlayClickThrough')) {
      delete settings.overlayClickThrough;
    }
    if (!Array.isArray(settings.categories)) {
      settings.categories = [];
    }
    if (!settings.mobOverlayBounds || typeof settings.mobOverlayBounds !== 'object') {
      settings.mobOverlayBounds = null;
    }
    if (!settings.mobWindows || typeof settings.mobWindows !== 'object') {
      settings.mobWindows = { kills: {} };
    } else if (!settings.mobWindows.kills || typeof settings.mobWindows.kills !== 'object') {
      settings.mobWindows.kills = {};
    }
    mobWindowManager.loadState(settings.mobWindows);
    const loadedRemote = await loadMobWindowsFromBackend();
    if (loadedRemote) {
      settings.mobWindows = mobWindowManager.serializeState();
      await saveSettings(settings);
    }
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
    const serializedMobWindows = mobWindowManager.serializeState();
    settings.mobWindows = serializedMobWindows;
    const payload = {
      ...updatedSettings,
      mobWindows: serializedMobWindows,
      mobOverlayBounds: settings.mobOverlayBounds,
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf8');
    await syncMobWindowsToBackend(serializedMobWindows);
  } catch (error) {
    console.error('Failed to persist settings', error);
  }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const iconPath = resolveAssetPath(APP_ICON_FILENAME);
  const hasIcon = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 640,
    icon: hasIcon ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(resolveRendererPath('index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('mob-windows:update', mobWindowManager.computeSnapshot());
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);
  mainWindow.on('minimize', updateTrayMenu);
  mainWindow.on('restore', updateTrayMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
    updateTrayMenu();
  });

  updateTrayMenu();
  return mainWindow;
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const iconPath = resolveAssetPath(APP_ICON_FILENAME);
  const hasIcon = fs.existsSync(iconPath);

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
    icon: hasIcon ? iconPath : undefined,
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
  overlayWindow.loadFile(resolveRendererPath('overlay-timers.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('timers:update', timerManager.getTimers());
    overlayWindow.webContents.send('overlay:move-mode', overlayMoveMode);
  });
  overlayWindow.setOpacity(settings.overlayOpacity);
  overlayWindow.setIgnoreMouseEvents(
    overlayMoveMode ? false : Boolean(settings.overlayClickThroughTimers),
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

  overlayWindow.on('show', updateTrayMenu);
  overlayWindow.on('hide', updateTrayMenu);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    updateTrayMenu();
  });

  updateTrayMenu();
  return overlayWindow;
}

function createMobOverlayWindow() {
  if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
    return mobOverlayWindow;
  }

  const iconPath = resolveAssetPath(APP_ICON_FILENAME);
  const hasIcon = fs.existsSync(iconPath);

  const baseBounds = { width: 320, height: 360 };
  const saved = settings.mobOverlayBounds || {};
  const windowOptions = {
    width: Number(saved.width) || baseBounds.width,
    height: Number(saved.height) || baseBounds.height,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    icon: hasIcon ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#00000000',
  };

  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    windowOptions.x = saved.x;
    windowOptions.y = saved.y;
  }

  mobOverlayWindow = new BrowserWindow(windowOptions);
  mobOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  mobOverlayWindow.loadFile(resolveRendererPath('overlay-mobs.html'));
  mobOverlayWindow.webContents.once('did-finish-load', () => {
    mobOverlayWindow.webContents.send('mob-windows:update', mobWindowManager.computeSnapshot());
    mobOverlayWindow.webContents.send('overlay:move-mode', overlayMoveMode);
  });
  mobOverlayWindow.setOpacity(settings.overlayOpacity);
  mobOverlayWindow.setIgnoreMouseEvents(
    overlayMoveMode ? false : Boolean(settings.overlayClickThroughMobs),
    { forward: true }
  );

  const scheduleSaveMobOverlayBounds = () => {
    if (mobOverlayBoundsSaveTimer) {
      clearTimeout(mobOverlayBoundsSaveTimer);
    }
    mobOverlayBoundsSaveTimer = setTimeout(async () => {
      mobOverlayBoundsSaveTimer = null;
      if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
        const b = mobOverlayWindow.getBounds();
        settings.mobOverlayBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        await saveSettings(settings);
      }
    }, 300);
  };

  mobOverlayWindow.on('move', scheduleSaveMobOverlayBounds);
  mobOverlayWindow.on('resize', scheduleSaveMobOverlayBounds);
  mobOverlayWindow.on('show', updateTrayMenu);
  mobOverlayWindow.on('hide', updateTrayMenu);
  mobOverlayWindow.on('closed', () => {
    mobOverlayWindow = null;
    updateTrayMenu();
  });

  updateTrayMenu();
  return mobOverlayWindow;
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

async function handleNewLines({ filePath, lines }) {
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

  const mobUpdated = mobWindowManager.ingestLines(decoratedLines);
  if (mobUpdated) {
    await saveSettings(settings);
  }
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

let mobWindowsFetchedFromBackend = false;

async function fetchMobWindowsFromBackend() {
  const baseUrl = (settings.backendUrl || '').trim();
  if (!baseUrl) {
    return null;
  }

  try {
    const response = await axios.get(joinBackendUrl(baseUrl, '/api/mob-windows'));
    const data = response?.data;
    if (!data || typeof data.kills !== 'object' || !data.kills) {
      return null;
    }
    return { kills: data.kills };
  } catch (error) {
    console.error('Failed to fetch mob windows from backend', error.message || error);
    return null;
  }
}

async function loadMobWindowsFromBackend({ force = false } = {}) {
  if (mobWindowsFetchedFromBackend && !force) {
    return false;
  }

  const remote = await fetchMobWindowsFromBackend();
  if (!remote) {
    return false;
  }

  mobWindowManager.loadState(remote);
  mobWindowsFetchedFromBackend = true;
  return true;
}

async function syncMobWindowsToBackend(state) {
  const baseUrl = (settings.backendUrl || '').trim();
  if (!baseUrl) {
    return;
  }
  const payload = state && typeof state === 'object' ? state : mobWindowManager.serializeState();
  if (!payload || typeof payload.kills !== 'object') {
    return;
  }
  try {
    await axios.post(joinBackendUrl(baseUrl, '/api/mob-windows'), { kills: payload.kills });
  } catch (error) {
    console.error('Failed to sync mob windows to backend', error.message || error);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('ready', async () => ensureSettingsLoaded());

  ipcMain.handle('settings:load', async () => ensureSettingsLoaded());

  ipcMain.handle('settings:update', async (_event, partialSettings) => {
    await ensureSettingsLoaded();
    const previousBackendUrl = settings.backendUrl || '';
    settings = {
      ...settings,
      ...partialSettings,
    };
    const backendUrlChanged =
      Object.prototype.hasOwnProperty.call(partialSettings || {}, 'backendUrl') &&
      (partialSettings.backendUrl || '') !== previousBackendUrl;
    if (backendUrlChanged) {
      mobWindowsFetchedFromBackend = false;
      if ((settings.backendUrl || '').trim()) {
        const loaded = await loadMobWindowsFromBackend({ force: true });
        if (loaded) {
          settings.mobWindows = mobWindowManager.serializeState();
        }
      }
    }

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

  ipcMain.handle('dialog:select-sound-file', async () => {
    const browserWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const result = await dialog.showOpenDialog(browserWindow, {
      title: 'Select Sound File',
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aac'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('watcher:start', async () => {
    await startWatcher();
    return { status: 'watching', directory: settings.logDirectory };
  });

  ipcMain.handle('watcher:stop', async () => {
    await stopWatcher();
    return { status: 'stopped' };
  });

  ipcMain.handle('overlay:set-click-through', async (_event, targetOrEnabled, maybeEnabled) => {
    await ensureSettingsLoaded();

    if (typeof maybeEnabled === 'undefined' && typeof targetOrEnabled === 'boolean') {
      const value = Boolean(targetOrEnabled);
      settings.overlayClickThroughTimers = value;
      settings.overlayClickThroughMobs = value;
    } else {
      const target = targetOrEnabled === 'mobs' ? 'mobs' : targetOrEnabled === 'both' ? 'both' : 'timers';
      const value = Boolean(maybeEnabled);
      if (target === 'mobs' || target === 'both') {
        settings.overlayClickThroughMobs = value;
      }
      if (target === 'timers' || target === 'both') {
        settings.overlayClickThroughTimers = value;
      }
    }

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(
        overlayMoveMode ? false : Boolean(settings.overlayClickThroughTimers),
        { forward: true }
      );
    }
    if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
      mobOverlayWindow.setIgnoreMouseEvents(
        overlayMoveMode ? false : Boolean(settings.overlayClickThroughMobs),
        { forward: true }
      );
    }

    await saveSettings(settings);
    return {
      timers: settings.overlayClickThroughTimers,
      mobs: settings.overlayClickThroughMobs,
    };
  });

  ipcMain.handle('overlay:set-opacity', async (_event, opacity) => {
    const nextOpacity = Math.min(1, Math.max(0.2, Number(opacity) || settings.overlayOpacity));
    settings.overlayOpacity = nextOpacity;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(nextOpacity);
    }
    if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
      mobOverlayWindow.setOpacity(nextOpacity);
    }
    await saveSettings(settings);
    return nextOpacity;
  });

  ipcMain.handle('overlay:show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
    }
    updateTrayMenu();
    return true;
  });

  ipcMain.handle('overlay:hide', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
    updateTrayMenu();
    return true;
  });

  ipcMain.handle('overlay:show-mobs', () => {
    if (!mobOverlayWindow || mobOverlayWindow.isDestroyed()) {
      createMobOverlayWindow();
    }
    if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
      if (typeof mobOverlayWindow.isMinimized === 'function' && mobOverlayWindow.isMinimized()) {
        mobOverlayWindow.restore();
      }
      mobOverlayWindow.showInactive();
    }
    updateTrayMenu();
    return true;
  });

  ipcMain.handle('overlay:hide-mobs', () => {
    if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
      mobOverlayWindow.hide();
    }
    updateTrayMenu();
    return true;
  });

  ipcMain.handle('overlay:move-mode', async (_event, enabled) => {
    overlayMoveMode = Boolean(enabled);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(overlayMoveMode ? false : Boolean(settings.overlayClickThroughTimers), { forward: true });
      if (typeof overlayWindow.setFocusable === 'function') {
        overlayWindow.setFocusable(overlayMoveMode);
      }
      if (overlayMoveMode) {
        overlayWindow.showInactive();
      }
      overlayWindow.webContents.send('overlay:move-mode', overlayMoveMode);
    }
    if (mobOverlayWindow && !mobOverlayWindow.isDestroyed()) {
      mobOverlayWindow.setIgnoreMouseEvents(overlayMoveMode ? false : Boolean(settings.overlayClickThroughMobs), { forward: true });
      if (typeof mobOverlayWindow.setFocusable === 'function') {
        mobOverlayWindow.setFocusable(overlayMoveMode);
      }
      if (overlayMoveMode) {
        mobOverlayWindow.showInactive();
      }
      mobOverlayWindow.webContents.send('overlay:move-mode', overlayMoveMode);
    }
    return overlayMoveMode;
  });

  ipcMain.handle('overlay:get-move-mode', () => overlayMoveMode);

  ipcMain.handle('overlay:resize', (_event, payload) => {
    try {
      if (!overlayMoveMode) return false;
      const sender = _event?.sender;
      if (!sender) return false;
      const win = BrowserWindow.fromWebContents(sender);
      if (!win || win.isDestroyed()) return false;

      const { edge, dx = 0, dy = 0 } = payload || {};
      if (typeof edge !== 'string') return false;

      const minW = 220;
      const minH = 160;
      const bounds = win.getBounds();
      let { x, y, width, height } = bounds;

      const applyWest = (delta) => {
        const desired = width - delta;
        const clampDelta = Math.min(delta, width - minW);
        width = Math.max(minW, desired);
        x = x + clampDelta;
      };
      const applyEast = (delta) => {
        width = Math.max(minW, width + delta);
      };
      const applyNorth = (delta) => {
        const desired = height - delta;
        const clampDelta = Math.min(delta, height - minH);
        height = Math.max(minH, desired);
        y = y + clampDelta;
      };
      const applySouth = (delta) => {
        height = Math.max(minH, height + delta);
      };

      const e = edge.toLowerCase();
      if (e.includes('w')) applyWest(dx || 0);
      if (e.includes('e')) applyEast(dx || 0);
      if (e.includes('n')) applyNorth(dy || 0);
      if (e.includes('s')) applySouth(dy || 0);

      // Final clamp
      width = Math.max(minW, Math.round(width));
      height = Math.max(minH, Math.round(height));
      x = Math.round(x);
      y = Math.round(y);

      win.setBounds({ x, y, width, height }, false);
      return { x, y, width, height };
    } catch (err) {
      console.error('overlay:resize failed', err);
      return false;
    }
  });

  ipcMain.handle('triggers:default', () => defaultTriggers);

  ipcMain.handle('mob-windows:get', () => mobWindowManager.computeSnapshot());
  ipcMain.handle('mob-windows:definitions', () => mobWindowManager.getDefinitions());
  ipcMain.handle('mob-windows:record-kill', async (_event, mobId, timestamp) => {
    const updated = mobWindowManager.recordKill(mobId, timestamp ? new Date(timestamp) : new Date());
    if (updated) {
      await saveSettings(settings);
    }
    return mobWindowManager.computeSnapshot();
  });
  ipcMain.handle('mob-windows:clear', async (_event, mobId) => {
    const cleared = mobWindowManager.clearKill(mobId);
    if (cleared) {
      await saveSettings(settings);
    }
    return mobWindowManager.computeSnapshot();
  });

  ipcMain.handle('triggers:import-gtp', async () => {
    // Ask user for a .gtp file
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select GINA package (.gtp)',
      filters: [{ name: 'GINA Package', extensions: ['gtp'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    const inputPath = result.filePaths[0];
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const scriptPath = path.join(scriptsDir, 'convert-gina-gtp.ps1');

    try {
      // Ensure output directory exists inside userData
      const importDir = path.join(app.getPath('userData'), 'imports');
      await fs.promises.mkdir(importDir, { recursive: true });
      const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
      const outputPath = path.join(importDir, `${base}.triggers.json`);

      // Spawn PowerShell converter
      await runPowerShellConverter(scriptPath, inputPath, outputPath);

      // Load converted triggers (strip any BOM defensively)
      const raw = await fs.promises.readFile(outputPath, 'utf8');
      const imported = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const colored = applyCategoryColors(imported);

      // Update settings and watcher
      settings.triggers = colored;
      await saveSettings(settings);
      if (logWatcher) {
        logWatcher.setTriggers(settings.triggers);
      }

      return colored;
    } catch (error) {
      console.error('Failed to import GINA .gtp', error);
      throw error;
    }
  });

  ipcMain.handle('triggers:export', async (_event, exportList) => {
    try {
      const toWrite = Array.isArray(exportList) && exportList.length > 0 ? exportList : settings.triggers || [];
      const defaultName = `EQGlobal-triggers-${new Date().toISOString().slice(0,10)}.json`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Triggers',
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }
      await fs.promises.writeFile(result.filePath, JSON.stringify(toWrite, null, 2), 'utf8');
      return result.filePath;
    } catch (error) {
      console.error('Failed to export triggers', error);
      throw error;
    }
  });
}

app.whenReady().then(async () => {
  await ensureSettingsLoaded();

  if (process.platform === 'darwin' && app.dock && typeof app.dock.setIcon === 'function') {
    const dockIcon = loadAssetImage(APP_ICON_FILENAME, { width: 256, height: 256 });
    if (dockIcon) {
      app.dock.setIcon(dockIcon);
    }
  }

  createMainWindow();
  createOverlayWindow();
  createMobOverlayWindow();
  ensureTray();
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
      if (!mobOverlayWindow) {
        createMobOverlayWindow();
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
  destroyTray();
  await stopWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
