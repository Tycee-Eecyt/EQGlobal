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

async function captureFile(filePath, outPath, {
  width = 1280,
  height = 720,
  injectCss = '',
  injectJs = '',
  waitMs = 0,
  requireInjection = false,
} = {}) {
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
        let injectedOk = true;
        if (injectJs && injectJs.trim()) {
          try {
            injectedOk = await win.webContents.executeJavaScript(injectJs, true);
          } catch (e) {
            injectedOk = false;
          }
        }
        if (requireInjection && !injectedOk) {
          console.warn('Skipping capture because injection failed for', filePath);
          resolve();
          return;
        }
        if (waitMs && waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
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

    // Overlay Timers (only if sample timers injected)
    await captureFile(
      path.join(rendererDir, 'overlay-timers.html'),
      path.join(outDir, 'overlay-timers.png'),
      {
        injectCss: 'html,body{background:#0f172a !important} .panel{box-shadow:none !important}',
        injectJs: `(() => {
          try {
            const now = Date.now();
            if (typeof updateTimers !== 'function') return false;
            updateTimers([
              { id: 't1', label: 'Complete Heal', duration: 120, color: '#ffd93d', expiresAt: new Date(now + 90_000).toISOString() },
              { id: 't2', label: 'Rampage', duration: 45, color: '#ffa94d', expiresAt: new Date(now + 28_000).toISOString() },
              { id: 't3', label: 'Cure', duration: 15, color: '#6bcff6', expiresAt: new Date(now + 12_000).toISOString() }
            ]);
            return true;
          } catch { return false; }
        })()`,
        waitMs: 2500,
        requireInjection: true,
      }
    );

    // Control Panel (main window) — wait longer for content
    await captureFile(
      path.join(rendererDir, 'index.html'),
      path.join(outDir, 'control-panel.png'),
      {
        injectCss: 'html,body{background:#0f172a !important} .panel{box-shadow:none !important}',
        waitMs: 3500,
      }
    );

    // Mob Windows (only if sample snapshot injected)
    await captureFile(
      path.join(rendererDir, 'overlay-mobs.html'),
      path.join(outDir, 'mob-windows.png'),
      {
        injectCss: 'html,body{background:#0f172a !important}',
        injectJs: `(() => {
          try {
            const now = Date.now();
            if (typeof updateMobWindows !== 'function') return false;
            updateMobWindows({ mobs: [
              { id: 'nagafen', name: 'Lord Nagafen', inWindow: true, secondsUntilClose: 3600, windowProgress: 0.25, lastKillAt: new Date(now - 7_200_000).toISOString(), windowClosesAt: new Date(now + 3_600_000).toISOString() },
              { id: 'trakanon', name: 'Trakanon', inWindow: false, secondsUntilOpen: 14_400, windowOpensAt: new Date(now + 14_400_000).toISOString(), windowClosesAt: new Date(now + 21_600_000).toISOString() },
              { id: 'venril', name: 'Venril Sathir', inWindow: false, secondsUntilOpen: 3_600, windowOpensAt: new Date(now + 3_600_000).toISOString(), windowClosesAt: new Date(now + 10_800_000).toISOString() }
            ]});
            return true;
          } catch { return false; }
        })()`,
        waitMs: 2000,
        requireInjection: true,
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
