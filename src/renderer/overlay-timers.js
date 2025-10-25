const overlayRoot = document.getElementById('overlay-root');
const timersContainer = document.getElementById('overlay-timers');

let rafHandle = null;
let overlayTimers = [];

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

function cancelAnimation() {
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function formatHMS(remainingSeconds) {
  const value = Math.max(0, Number(remainingSeconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function renderTimers() {
  if (!timersContainer) {
    return;
  }
  const timers = Array.isArray(overlayTimers) ? overlayTimers : [];
  if (timers.length === 0) {
    cancelAnimation();
    timersContainer.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-card-title">Active Timers</div>
        <div class="overlay-card-body">
          <div class="empty-state">No active timers</div>
        </div>
      </div>
    `;
    return;
  }

  const rowsHtml = timers
    .map((timer) => {
      const totalMs = Math.max(1, (Number(timer.duration) || 0) * 1000);
      const expiresAt = Date.parse(timer.expiresAt) || Date.now() + totalMs;
      const remainingMs = Math.max(0, Number(timer.remainingMs) || Math.max(0, expiresAt - Date.now()));
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const pct = Math.max(0, Math.min(100, Math.round((remainingMs / totalMs) * 100)));
      const soon = remainingSeconds <= 10;
      const accent = typeof timer.color === 'string' && timer.color.trim() ? timer.color.trim() : '#00c9ff';
      return `
        <div
          class="overlay-timer ${soon ? 'soon' : ''}"
          data-exp="${expiresAt}"
          data-dur="${totalMs}"
          data-id="${escapeHtml(timer.id || '')}"
          style="--accent: ${escapeHtml(accent)}"
        >
          <div class="overlay-timer-fill" style="width: ${pct}%;"></div>
          <div class="overlay-timer-content">
            <span class="overlay-timer-label">${escapeHtml(timer.label || '')}</span>
            <span class="overlay-timer-time">${formatHMS(remainingSeconds)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  timersContainer.innerHTML = `
    <div class="overlay-card overlay-timers-card">
      <div class="overlay-card-title">Active Timers</div>
      <div class="overlay-card-body">
        ${rowsHtml}
      </div>
    </div>
  `;

  startTimerAnimation();
}

function startTimerAnimation() {
  cancelAnimation();
  const step = () => {
    const now = Date.now();
    const rows = timersContainer ? timersContainer.querySelectorAll('.overlay-timer') : [];
    if (!rows || rows.length === 0) {
      cancelAnimation();
      return;
    }
    rows.forEach((row) => {
      const exp = Number(row.dataset.exp) || 0;
      const dur = Math.max(1, Number(row.dataset.dur) || 1);
      const remMs = Math.max(0, exp - now);
      const pct = Math.max(0, Math.min(100, Math.round((remMs / dur) * 100)));
      const fill = row.querySelector('.overlay-timer-fill');
      if (fill) fill.style.width = `${pct}%`;
      const timeEl = row.querySelector('.overlay-timer-time');
      if (timeEl) timeEl.textContent = formatHMS(Math.ceil(remMs / 1000));
      row.classList.toggle('soon', Math.ceil(remMs / 1000) <= 10);
    });
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
}

function updateTimers(timers) {
  overlayTimers = Array.isArray(timers) ? timers : [];
  renderTimers();
}

if (window.eqApi.onTimersUpdate) {
  window.eqApi.onTimersUpdate(updateTimers);
}

if (window.eqApi.onOverlayMoveMode) {
  window.eqApi.onOverlayMoveMode((enabled) => {
    if (!overlayRoot) return;
    overlayRoot.classList.toggle('move-mode', Boolean(enabled));
  });
}

renderTimers();

// Install resize handles for move-mode
(function installResizeHandles() {
  const handles = document.querySelectorAll('.overlay-resize-handle[data-edge]');
  if (!handles || handles.length === 0 || !window.eqApi || !window.eqApi.resizeOverlay) return;

  let dragging = false;
  let edge = null;
  let prevScreenX = 0;
  let prevScreenY = 0;

  function onMove(e) {
    if (!dragging) return;
    const dx = (e.screenX || 0) - prevScreenX;
    const dy = (e.screenY || 0) - prevScreenY;
    prevScreenX = e.screenX || 0;
    prevScreenY = e.screenY || 0;
    if (dx !== 0 || dy !== 0) {
      window.eqApi.resizeOverlay(edge, dx, dy);
    }
    e.preventDefault();
  }

  function onUp(e) {
    dragging = false;
    edge = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    e.preventDefault();
  }

  handles.forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      dragging = true;
      edge = String(el.dataset.edge || '').toLowerCase();
      prevScreenX = e.screenX || 0;
      prevScreenY = e.screenY || 0;
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      e.preventDefault();
      e.stopPropagation();
    });
  });
})();
