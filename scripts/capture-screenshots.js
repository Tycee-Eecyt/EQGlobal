/* Quick Electron screenshot capture for renderer views.
 * Generates PNGs under docs/screenshots.
 */
let electron;
try {
  electron = require('electron');
} catch (_) {
  try { electron = require('electron/main'); } catch (_) { electron = {}; }
}
const app = electron.app || (electron.default && electron.default.app);
const BrowserWindow = electron.BrowserWindow || (electron.default && electron.default.BrowserWindow);
if (!app || !BrowserWindow) {
  console.error('Electron app/BrowserWindow not available. Ensure this script is executed via `electron` binary.');
  process.exit(1);
}
const path = require('path');
const fs = require('fs');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function captureFile(filePath, outPath, { width = 1280, height = 720, injectCss = '' } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.webContents.once('did-finish-load', async () => {
      try {
        if (injectCss && injectCss.trim()) {
          await win.webContents.insertCSS(injectCss);
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(outPath, image.toPNG());
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        win.close();
      }
    });

    win.loadFile(filePath).catch(reject);
  });
}

app.whenReady().then(async () => {
  try {
    const root = path.resolve(__dirname, '..');
    const rendererDir = path.join(root, 'src', 'renderer');
    const outDir = path.join(root, 'docs', 'screenshots');
    ensureDir(outDir);

    // Overlay Timers
    await captureFile(
      path.join(rendererDir, 'overlay-timers.html'),
      path.join(outDir, 'overlay-timers.png'),
      {
        injectCss:
          'html,body{background:#0f172a !important} .panel{box-shadow:none !important}',
      }
    );

    // Control Panel (main window)
    await captureFile(
      path.join(rendererDir, 'index.html'),
      path.join(outDir, 'control-panel.png'),
      {
        injectCss:
          'html,body{background:#0f172a !important} .panel{box-shadow:none !important}',
      }
    );

    // Mob Windows
    await captureFile(
      path.join(rendererDir, 'overlay-mobs.html'),
      path.join(outDir, 'mob-windows.png'),
      {
        injectCss: 'html,body{background:#0f172a !important}',
      }
    );

    console.log('Screenshots saved to', outDir);
  } catch (err) {
    console.error('Failed to capture screenshots', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
