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
    .map(
      (timer) => `
        <div class="timer-entry" style="border-left: 6px solid ${timer.color || '#00eaff'};">
          <span>${escapeHtml(timer.label)}</span>
          <span class="remaining">${formatRemaining(timer.remainingSeconds)}</span>
        </div>
      `
    )
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

renderOverlay([]);
