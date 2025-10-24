const overlayRoot = document.getElementById('overlay-root');
const mobsContainer = document.getElementById('overlay-mobs');

let mobWindowSnapshot = { mobs: [] };

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

function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const abs = Math.max(0, Math.round(seconds));
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3_600);
  const minutes = Math.floor((abs % 3_600) / 60);
  const secs = abs % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (parts.length < 2 && hours > 0) parts.push(`${hours}h`);
  if (parts.length < 2 && minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.max(1, secs)}s`);
  return parts.join(' ');
}

function formatCountdown(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'Unknown';
  }
  if (seconds <= 0) {
    return 'now';
  }
  return formatDurationShort(seconds);
}

function formatAbsoluteTime(isoString) {
  if (!isoString) {
    return 'Unknown';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  const now = new Date();
  const options = { hour: 'numeric', minute: '2-digit' };
  if (date.toDateString() !== now.toDateString()) {
    options.month = 'short';
    options.day = 'numeric';
  }
  return date.toLocaleString(undefined, options);
}

function formatSince(isoString) {
  if (!isoString) {
    return '';
  }
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const diffSeconds = Math.round((Date.now() - parsed) / 1000);
  if (diffSeconds < 10) {
    return 'moments ago';
  }
  return `${formatDurationShort(diffSeconds)} ago`;
}

function categorizeMobs(mobs = []) {
  const current = [];
  const upcoming = [];
  mobs.forEach((mob) => {
    if (!mob || !mob.id) {
      return;
    }
    if (mob.inWindow) {
      current.push(mob);
    } else if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0 && mob.secondsUntilOpen <= 86_400) {
      upcoming.push(mob);
    }
  });

  const sortBy = (key) => (a, b) => {
    const av = Number.isFinite(a[key]) ? a[key] : Number.MAX_SAFE_INTEGER;
    const bv = Number.isFinite(b[key]) ? b[key] : Number.MAX_SAFE_INTEGER;
    return av - bv;
  };

  current.sort(sortBy('secondsUntilClose'));
  upcoming.sort(sortBy('secondsUntilOpen'));
  return { current, upcoming };
}

function buildMobItem(mob, mode) {
  const progress =
    mode === 'current' ? Math.max(0, Math.min(100, Math.round((Number(mob.windowProgress) || 0) * 100))) : 0;
  const status =
    mode === 'current'
      ? `Ends in ${formatCountdown(mob.secondsUntilClose)}`
      : `Opens in ${formatCountdown(mob.secondsUntilOpen)}`;
  const leftMeta =
    mode === 'current'
      ? formatSince(mob.lastKillAt) || ''
      : mob.windowOpensAt
        ? `Earliest ${formatAbsoluteTime(mob.windowOpensAt)}`
        : '';
  const rightMeta = mob.windowClosesAt
    ? `${mode === 'current' ? 'Ends' : 'Latest'} ${formatAbsoluteTime(mob.windowClosesAt)}`
    : '';

  return `
    <div class="overlay-mob-item">
      <div class="mob-top">
        <span class="mob-name">${escapeHtml(mob.name || '')}</span>
        <span class="mob-status">${escapeHtml(status)}</span>
      </div>
      <div class="overlay-mob-progress" style="--progress: ${progress}%;"><span style="width: ${progress}%;"></span></div>
      <div class="mob-meta">
        <span>${escapeHtml(leftMeta)}</span>
        <span>${escapeHtml(rightMeta)}</span>
      </div>
    </div>
  `;
}

function renderMobWindows() {
  if (!mobsContainer) {
    return;
  }
  const mobs = Array.isArray(mobWindowSnapshot?.mobs) ? mobWindowSnapshot.mobs : [];
  if (mobs.length === 0) {
    mobsContainer.innerHTML = `
      <div class="overlay-card">
        <div class="overlay-card-title">Mob Windows</div>
        <div class="overlay-card-body">
          <div class="empty-state">No mob window data yet.</div>
        </div>
      </div>
    `;
    return;
  }

  const { current, upcoming } = categorizeMobs(mobs);
  const currentMarkup =
    current.length > 0
      ? current.slice(0, 6).map((mob) => buildMobItem(mob, 'current')).join('')
      : '<div class="empty-state">No mobs are currently in window.</div>';
  const upcomingMarkup =
    upcoming.length > 0
      ? upcoming.slice(0, 6).map((mob) => buildMobItem(mob, 'upcoming')).join('')
      : '<div class="empty-state">No windows in the next 24 hours.</div>';

  mobsContainer.innerHTML = `
    <div class="overlay-card">
      <div class="overlay-card-title">Mobs In Window</div>
      <div class="overlay-card-body overlay-mob-list">
        ${currentMarkup}
      </div>
    </div>
    <div class="overlay-card">
      <div class="overlay-card-title">Next 24 Hours</div>
      <div class="overlay-card-body overlay-mob-list">
        ${upcomingMarkup}
      </div>
    </div>
  `;
}

function updateMobWindows(snapshot) {
  mobWindowSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : { mobs: [] };
  renderMobWindows();
}

if (window.eqApi.onMobWindowsUpdate) {
  window.eqApi.onMobWindowsUpdate(updateMobWindows);
}

if (window.eqApi.getMobWindows) {
  window.eqApi
    .getMobWindows()
    .then(updateMobWindows)
    .catch(() => {});
}

if (window.eqApi.onOverlayMoveMode) {
  window.eqApi.onOverlayMoveMode((enabled) => {
    if (!overlayRoot) return;
    overlayRoot.classList.toggle('move-mode', Boolean(enabled));
  });
}

renderMobWindows();
