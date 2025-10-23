const overlayRoot = document.getElementById('overlay-root');
let rafHandle = null;

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

function renderOverlay(timers) {
  if (!timers || timers.length === 0) {
    cancelAnimation();
    overlayRoot.innerHTML = '<div class="empty-state">No active timers</div>';
    return;
  }

  overlayRoot.innerHTML = timers
    .map((timer) => {
      const totalMs = Math.max(1, (Number(timer.duration) || 0) * 1000);
      const expiresAt = Date.parse(timer.expiresAt) || (Date.now() + totalMs);
      const remainingMs = Math.max(0, Number(timer.remainingMs) || Math.max(0, expiresAt - Date.now()));
      const pct = Math.max(0, Math.min(100, Math.round((remainingMs / totalMs) * 100)));
      const soon = (Number(timer.remainingSeconds) || Math.ceil(remainingMs / 1000)) <= 10;
      return `
        <div class="timer-row ${soon ? 'soon' : ''}" data-exp="${expiresAt}" data-dur="${totalMs}" data-id="${timer.id}">
          <span class="time">${formatHMS(Math.ceil(remainingMs / 1000))}</span>
          <div class="bar-container">
            <div class="bar-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="label">${escapeHtml(timer.label)}</span>
        </div>
      `;
    })
    .join('');

  // Smooth animation between backend ticks
  cancelAnimation();
  const step = () => {
    const now = Date.now();
    const rows = overlayRoot.querySelectorAll('.timer-row');
    if (rows.length === 0) {
      cancelAnimation();
      return;
    }
    rows.forEach((row) => {
      const exp = Number(row.dataset.exp) || 0;
      const dur = Math.max(1, Number(row.dataset.dur) || 1);
      const remMs = Math.max(0, exp - now);
      const pct = Math.max(0, Math.min(100, Math.round((remMs / dur) * 100)));
      const fill = row.querySelector('.bar-fill');
      if (fill) fill.style.width = `${pct}%`;
      const timeEl = row.querySelector('.time');
      if (timeEl) timeEl.textContent = formatHMS(Math.ceil(remMs / 1000));
      row.classList.toggle('soon', Math.ceil(remMs / 1000) <= 10);
    });
    rafHandle = requestAnimationFrame(step);
  };
  rafHandle = requestAnimationFrame(step);
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

window.eqApi.onTimersUpdate((timers) => {
  renderOverlay(timers);
});

// Reflect move mode visually in the overlay
if (window.eqApi.onOverlayMoveMode) {
  window.eqApi.onOverlayMoveMode((enabled) => {
    if (!overlayRoot) return;
    overlayRoot.classList.toggle('move-mode', Boolean(enabled));
  });
}

renderOverlay([]);
