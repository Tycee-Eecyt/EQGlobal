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
      const accent = timer.color || '#00eaff';
      return `
        <div class="timer-entry" style="--accent: ${accent};">
          <div class="progress-track">
            <div class="progress-fill" style="height: ${pct}%; background: ${accent};"></div>
          </div>
          <div class="timer-content">
            <span>${escapeHtml(timer.label)}</span>
            <span class="remaining">${formatRemaining(timer.remainingSeconds)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function formatRemaining(remainingSeconds) {
  const value = Math.max(0, Number(remainingSeconds) || 0);
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
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
