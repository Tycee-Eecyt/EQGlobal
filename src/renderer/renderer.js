const STATUS_COLORS = {
  watching: '#49d1a4',
  stopped: '#ff6b6b',
  error: '#ff9f43',
  idle: '#7d8597',
};

let triggers = [];
let recentLines = [];

const logDirectoryInput = document.getElementById('log-directory');
const chooseLogDirButton = document.getElementById('choose-log-dir');
const backendUrlInput = document.getElementById('backend-url');
const overlayOpacityInput = document.getElementById('overlay-opacity');
const overlayOpacityValue = document.getElementById('overlay-opacity-value');
const overlayClickThroughInput = document.getElementById('overlay-clickthrough');
const watcherStatus = document.getElementById('watcher-status');
const triggersList = document.getElementById('triggers-list');
const activeTimersContainer = document.getElementById('active-timers');
const recentLinesList = document.getElementById('recent-lines');
const toggleMoveModeButton = document.getElementById('toggle-move-mode');
let overlayMoveMode = false;

function escapeHtml(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateStatus({ state, message, directory } = {}) {
  const status = state || 'idle';
  watcherStatus.textContent = status === 'watching' && directory ? `Watching ${directory}` : status.toUpperCase();
  watcherStatus.style.backgroundColor = `${STATUS_COLORS[status] || STATUS_COLORS.idle}1A`;
  watcherStatus.style.color = STATUS_COLORS[status] || STATUS_COLORS.idle;
  if (message) {
    watcherStatus.title = message;
  }
}

function renderTriggers() {
  if (!Array.isArray(triggers) || triggers.length === 0) {
    triggersList.innerHTML =
      '<p class="empty-state">No triggers configured yet. Add a trigger or reset to defaults.</p>';
    return;
  }

  triggersList.innerHTML = triggers
    .map(
      (trigger, index) => `
      <div class="trigger-card" data-index="${index}">
        <div class="row">
          <label>Label</label>
          <input type="text" class="trigger-label" value="${escapeHtml(trigger.label || '')}" placeholder="Timer name" />
        </div>
        <div class="row">
          <label>Pattern</label>
          <input type="text" class="trigger-pattern" value="${escapeHtml(trigger.pattern || '')}" placeholder="Match text or regex" />
        </div>
        <div class="row">
          <label>Duration (seconds)</label>
          <input type="number" min="1" class="trigger-duration" value="${Number(trigger.duration) || 0}" />
        </div>
        <div class="row">
          <label>Color</label>
          <input type="color" class="trigger-color" value="${escapeHtml(trigger.color || '#00c9ff')}" />
        </div>
        <div class="row inline">
          <input type="checkbox" class="trigger-regex" id="trigger-regex-${index}" ${trigger.isRegex ? 'checked' : ''} />
          <label for="trigger-regex-${index}">Use Regex</label>
        </div>
        <button class="secondary small remove-trigger" type="button">Remove</button>
      </div>
    `
    )
    .join('');
}

function collectTriggersFromDom() {
  const cards = Array.from(document.querySelectorAll('.trigger-card'));
  return cards
    .map((card) => {
      const label = card.querySelector('.trigger-label').value.trim();
      const pattern = card.querySelector('.trigger-pattern').value.trim();
      const duration = Number(card.querySelector('.trigger-duration').value);
      const color = card.querySelector('.trigger-color').value.trim() || '#00c9ff';
      const isRegex = card.querySelector('.trigger-regex').checked;

      if (!pattern || Number.isNaN(duration) || duration <= 0) {
        return null;
      }

      return {
        id: `${label || pattern}`.toLowerCase().replace(/\s+/g, '-'),
        label: label || pattern,
        pattern,
        duration,
        color,
        isRegex,
      };
    })
    .filter(Boolean);
}

function renderTimers(timers) {
  if (!timers || timers.length === 0) {
    activeTimersContainer.innerHTML = '<p class="empty-state">No active timers.</p>';
    return;
  }

  activeTimersContainer.innerHTML = timers
    .map(
      (timer) => `
      <div class="timer-pill" style="background: ${timer.color || '#3a3f52'};">
        <span>${escapeHtml(timer.label)}</span>
        <span class="remaining">${formatRemaining(timer.remainingSeconds)}</span>
      </div>`
    )
    .join('');
}

function formatRemaining(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return minutes > 0 ? `${minutes}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
}

function renderRecentLines() {
  if (recentLines.length === 0) {
    recentLinesList.innerHTML = '<li class="empty-state">Awaiting log data…</li>';
    return;
  }

  recentLinesList.innerHTML = recentLines
    .map(
      (entry) => `
      <li>
        <strong>${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</strong>
        &nbsp;
        ${escapeHtml(entry.line)}
      </li>`
    )
    .join('');
}

async function persistSettings() {
  const payload = {
    logDirectory: logDirectoryInput.value.trim(),
    backendUrl: backendUrlInput.value.trim(),
    overlayOpacity: Number(overlayOpacityInput.value),
    overlayClickThrough: overlayClickThroughInput.checked,
    triggers: collectTriggersFromDom(),
  };

  triggers = payload.triggers;
  await window.eqApi.updateSettings(payload);
}

async function hydrate() {
  await window.eqApi.ready();
  const stored = await window.eqApi.loadSettings();
  logDirectoryInput.value = stored.logDirectory || '';
  backendUrlInput.value = stored.backendUrl || '';
  overlayOpacityInput.value = stored.overlayOpacity || 0.85;
  overlayClickThroughInput.checked = Boolean(stored.overlayClickThrough);
  overlayOpacityValue.textContent = Number(overlayOpacityInput.value).toFixed(2);
  triggers = Array.isArray(stored.triggers) && stored.triggers.length > 0 ? stored.triggers : [];
  renderTriggers();

  // Initialize move mode button state
  try {
    overlayMoveMode = Boolean(await window.eqApi.getOverlayMoveMode());
  } catch (_) {
    overlayMoveMode = false;
  }
  updateMoveModeButton();
}

function attachEventListeners() {
  chooseLogDirButton.addEventListener('click', async () => {
    const directory = await window.eqApi.selectLogDirectory();
    if (directory) {
      logDirectoryInput.value = directory;
      await persistSettings();
    }
  });

  document.getElementById('start-watcher').addEventListener('click', async () => {
    try {
      await persistSettings();
      await window.eqApi.startWatcher();
    } catch (error) {
      console.error('Failed to start watcher', error);
    }
  });

  document.getElementById('stop-watcher').addEventListener('click', async () => {
    try {
      await window.eqApi.stopWatcher();
    } catch (error) {
      console.error('Failed to stop watcher', error);
    }
  });

  document.getElementById('save-triggers').addEventListener('click', async () => {
    await persistSettings();
  });

  document.getElementById('add-trigger').addEventListener('click', () => {
    triggers.push({
      label: 'New Trigger',
      pattern: '',
      duration: 30,
      color: '#00c9ff',
      isRegex: false,
    });
    renderTriggers();
  });

  document.getElementById('reset-triggers').addEventListener('click', async () => {
    triggers = await window.eqApi.loadDefaultTriggers();
    renderTriggers();
    await persistSettings();
  });

  const importBtn = document.getElementById('import-gtp');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      try {
        const imported = await window.eqApi.importGinaGtp();
        if (Array.isArray(imported) && imported.length > 0) {
          triggers = imported;
          renderTriggers();
          await persistSettings();
        }
      } catch (err) {
        console.error('Import failed', err);
        alert('Failed to import GINA .gtp. Check console for details.');
      }
    });
  }

  const exportBtn = document.getElementById('export-triggers');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const current = collectTriggersFromDom();
        await window.eqApi.exportTriggers(current);
      } catch (err) {
        console.error('Export failed', err);
        alert('Failed to export triggers. Check console for details.');
      }
    });
  }

  triggersList.addEventListener('click', (event) => {
    if (event.target.classList.contains('remove-trigger')) {
      const card = event.target.closest('.trigger-card');
      const index = Number(card.dataset.index);
      triggers.splice(index, 1);
      renderTriggers();
    }
  });

  backendUrlInput.addEventListener('blur', persistSettings);

  overlayOpacityInput.addEventListener('input', async (event) => {
    const value = Number(event.target.value) || 0.85;
    overlayOpacityValue.textContent = value.toFixed(2);
    await window.eqApi.setOverlayOpacity(value);
    await persistSettings();
  });

  overlayClickThroughInput.addEventListener('change', async (event) => {
    await window.eqApi.setOverlayClickThrough(event.target.checked);
    await persistSettings();
  });

  document.getElementById('show-overlay').addEventListener('click', () => {
    window.eqApi.showOverlay();
  });

  toggleMoveModeButton.addEventListener('click', async () => {
    try {
      overlayMoveMode = !(overlayMoveMode === true);
      const actual = await window.eqApi.setOverlayMoveMode(overlayMoveMode);
      overlayMoveMode = Boolean(actual);
      updateMoveModeButton();
    } catch (err) {
      console.error('Failed to toggle overlay move mode', err);
    }
  });
}

function subscribeToIpc() {
  window.eqApi.onTimersUpdate((timers) => {
    renderTimers(timers);
  });

  window.eqApi.onWatcherStatus((status) => {
    updateStatus(status);
  });

  window.eqApi.onWatcherLines((lines) => {
    recentLines = [...lines, ...recentLines].slice(0, 30);
    renderRecentLines();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await hydrate();
  attachEventListeners();
  subscribeToIpc();
  renderTimers([]);
  renderRecentLines();
  updateStatus({ state: 'idle' });
});

function updateMoveModeButton() {
  if (!toggleMoveModeButton) return;
  toggleMoveModeButton.textContent = overlayMoveMode ? 'Done Moving' : 'Move Overlay';
  toggleMoveModeButton.classList.toggle('active', overlayMoveMode);
}
