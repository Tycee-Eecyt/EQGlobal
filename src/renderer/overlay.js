const overlayRoot = document.getElementById('overlay-root');

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

function renderOverlay(timers) {
  if (!timers || timers.length === 0) {
    overlayRoot.innerHTML = '<div class="empty-state">No active timers</div>';
    return;
  }

  overlayRoot.innerHTML = timers
    .map((timer) => {
      const totalMs = Math.max(1, (Number(timer.duration) || 0) * 1000);
      const remainingMs = Math.max(0, Number(timer.remainingMs) || 0);
      const pct = Math.max(0, Math.min(100, Math.round((remainingMs / totalMs) * 100)));
      const soon = (Number(timer.remainingSeconds) || 0) <= 10;
      return `
        <div class="timer-row ${soon ? 'soon' : ''}">
          <span class="time">${formatHMS(timer.remainingSeconds)}</span>
          <div class="bar-container">
            <div class="bar-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="label">${escapeHtml(timer.label)}</span>
        </div>
      `;
    })
    .join('');
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
