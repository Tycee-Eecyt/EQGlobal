import {
  ROLE_LEVELS,
  fetchWithAuth,
  login as authLogin,
  logout as authLogout,
  onAuthChanged,
  getAuthState,
  hasRoleAtMost,
  isSignedIn,
} from './auth.js';

const currentList = document.getElementById('current-list');
const upcomingList = document.getElementById('upcoming-list');
const futureList = document.getElementById('future-list');
const tableBody = document.querySelector('#mob-table tbody');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshButton = document.getElementById('refresh-button');
const authForm = document.getElementById('auth-form');
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authLoginButton = document.getElementById('auth-login-button');
const authLogoutButton = document.getElementById('auth-logout-button');
const authFeedback = document.getElementById('auth-feedback');
const authUserLabel = document.getElementById('auth-user-label');
const authRoleLabel = document.getElementById('auth-role-label');

const REFRESH_INTERVAL = 30000;
const UPCOMING_WINDOW_SECONDS = 24 * 60 * 60;
const FUTURE_WINDOW_SECONDS = 72 * 60 * 60;
let authState = getAuthState();
let refreshTimer = null;
let dataLoaded = false;

function canViewMobWindows() {
  return hasRoleAtMost(ROLE_LEVELS.TRACKER);
}

function setAuthFeedback(message, { success = false } = {}) {
  if (!authFeedback) {
    return;
  }
  if (!message) {
    authFeedback.textContent = '';
    authFeedback.classList.remove('success');
    return;
  }
  authFeedback.textContent = message;
  authFeedback.classList.toggle('success', success);
}

function clearDisplays(message) {
  if (currentList) {
    currentList.classList.add('empty');
    currentList.textContent = message;
  }
  if (upcomingList) {
    upcomingList.classList.add('empty');
    upcomingList.textContent = message;
  }
  if (futureList) {
    futureList.classList.add('empty');
    futureList.textContent = message;
  }
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="5" class="table-empty">${message}</td></tr>`;
  }
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = message;
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (canViewMobWindows()) {
    refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL);
  }
}

function updateAuthUI(message = null, options = {}) {
  if (authUserLabel) {
    authUserLabel.textContent = authState.user ? `Signed in as ${authState.user.username}` : 'Not signed in';
  }
  if (authRoleLabel) {
    const roleLevel = Number(authState?.user?.roleLevel);
    const roleName = authState?.user?.roleName;
    authRoleLabel.textContent = authState.user
      ? `Role: ${roleName || (Number.isFinite(roleLevel) ? `Level ${roleLevel}` : 'Unknown')}`
      : '';
  }
  if (authUsernameInput) {
    authUsernameInput.disabled = isSignedIn();
  }
  if (authPasswordInput) {
    authPasswordInput.value = '';
    authPasswordInput.disabled = isSignedIn();
  }
  if (authLoginButton) {
    authLoginButton.classList.toggle('hidden', isSignedIn());
    authLoginButton.disabled = isSignedIn();
  }
  if (authLogoutButton) {
    authLogoutButton.classList.toggle('hidden', !isSignedIn());
    authLogoutButton.disabled = !isSignedIn();
  }

  const authorized = canViewMobWindows();
  if (refreshButton) {
    refreshButton.disabled = !authorized;
  }

  if (authorized) {
    if (message !== null) {
      setAuthFeedback(message, options);
    } else {
      setAuthFeedback('');
    }
    if (!dataLoaded) {
      dataLoaded = true;
      fetchAndRender();
    }
    startAutoRefresh();
  } else {
    dataLoaded = false;
    stopAutoRefresh();
    clearDisplays('Sign in with tracker access to view mob windows.');
    const feedbackMessage = message !== null ? message : 'Tracker access required to view mob windows.';
    setAuthFeedback(feedbackMessage, options);
  }
}

function formatAbsolute(value) {
  if (!value) {
    return 'Unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleString();
}

function formatSince(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'N/A';
  }
  const abs = Math.abs(Math.round(seconds));
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3_600);
  const minutes = Math.floor((abs % 3_600) / 60);
  const secs = abs % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (parts.length < 2 && hours > 0) parts.push(`${hours}h`);
  if (parts.length < 2 && minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.max(1, secs)}s`);
  return `${parts.join(' ')} ${seconds >= 0 ? 'ago' : 'from now'}`;
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

function formatRespawnRange(mob) {
  if (!mob) return 'Unknown';
  if (mob.minRespawnMinutes === mob.maxRespawnMinutes) {
    return `${Math.round(mob.minRespawnMinutes / 60)}h`;
  }
  const min = Math.round(mob.minRespawnMinutes / 60);
  const max = Math.round(mob.maxRespawnMinutes / 60);
  return `${min}h - ${max}h`;
}

function formatWindowBounds(mob) {
  if (!mob) return null;
  const earliest = mob.windowOpensAt ? new Date(mob.windowOpensAt) : null;
  const latest = mob.windowClosesAt ? new Date(mob.windowClosesAt) : null;
  if (!earliest && !latest) {
    return null;
  }
  return {
    earliest: earliest
      ? earliest.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
      : null,
    latest: latest
      ? latest.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
      : null,
  };
}

function statusForMob(mob) {
  if (!mob) {
    return { text: 'Unknown', className: 'neutral' };
  }
  if (mob.inWindow) {
    const remaining = Number.isFinite(mob.secondsUntilClose)
      ? `closes in ${formatCountdown(mob.secondsUntilClose)}`
      : 'currently active';
    return { text: `In window - ${remaining}`, className: 'danger' };
  }
  if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0) {
    return { text: `Opens in ${formatCountdown(mob.secondsUntilOpen)}`, className: 'neutral' };
  }
  if (!mob.lastKillAt) {
    return { text: 'Awaiting first kill', className: 'neutral' };
  }
  return { text: 'Window closed', className: 'neutral' };
}

function renderMobCard(container, mob) {
  const card = document.createElement('article');
  card.className = 'mob-card';

  const title = document.createElement('h3');
  title.textContent = mob.name;
  card.appendChild(title);

  const status = statusForMob(mob);
  const chip = document.createElement('span');
  chip.className = `status-chip ${status.className}`;
  chip.textContent = status.text;
  card.appendChild(chip);

  const meta = document.createElement('div');
  meta.className = 'mob-meta';
  const zone = mob.zone ? `${mob.zone}${mob.expansion ? ` - ${mob.expansion}` : ''}` : '';
  if (zone) {
    meta.appendChild(document.createTextNode(zone));
  }
  if (mob.lastKillAt) {
    meta.appendChild(document.createTextNode(`Last kill ${formatSince(mob.secondsSinceKill)}`));
  }
  meta.appendChild(document.createTextNode(`Respawn ${formatRespawnRange(mob)}`));
  card.appendChild(meta);

  const windowBounds = formatWindowBounds(mob);
  if (windowBounds && (windowBounds.earliest || windowBounds.latest)) {
    const boundsRow = document.createElement('div');
    boundsRow.className = 'mob-window-times';
    boundsRow.textContent = `${windowBounds.earliest ? `Earliest ${windowBounds.earliest}` : ''}${
      windowBounds.earliest && windowBounds.latest ? ' | ' : ''
    }${windowBounds.latest ? `Latest ${windowBounds.latest}` : ''}`.trim();
    card.appendChild(boundsRow);
  }

  container.appendChild(card);
}

function renderLists(snapshot) {
  const mobs = Array.isArray(snapshot?.mobs) ? snapshot.mobs : [];
  const generatedAt = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : new Date();

  const current = mobs.filter((mob) => mob.inWindow);
  const upcoming = mobs.filter(
    (mob) =>
      !mob.inWindow &&
      Number.isFinite(mob.secondsUntilOpen) &&
      mob.secondsUntilOpen > 0 &&
      mob.secondsUntilOpen <= UPCOMING_WINDOW_SECONDS
  );
  const future = mobs.filter(
    (mob) =>
      !mob.inWindow &&
      Number.isFinite(mob.secondsUntilOpen) &&
      mob.secondsUntilOpen > UPCOMING_WINDOW_SECONDS &&
      mob.secondsUntilOpen <= FUTURE_WINDOW_SECONDS
  );

  currentList.innerHTML = '';
  if (current.length === 0) {
    currentList.classList.add('empty');
    currentList.textContent = 'No mobs are currently in window.';
  } else {
    currentList.classList.remove('empty');
    current.forEach((mob) => renderMobCard(currentList, mob));
  }

  upcomingList.innerHTML = '';
  if (upcoming.length === 0) {
    upcomingList.classList.add('empty');
    upcomingList.textContent = 'No mobs will open within the next 24 hours.';
  } else {
    upcomingList.classList.remove('empty');
    upcoming.forEach((mob) => renderMobCard(upcomingList, mob));
  }

  if (futureList) {
    futureList.innerHTML = '';
    if (future.length === 0) {
      futureList.classList.add('empty');
      futureList.textContent = 'No additional mobs expected in the next 72 hours.';
    } else {
      futureList.classList.remove('empty');
      future.forEach((mob) => renderMobCard(futureList, mob));
    }
  }

  const tbody = document.createDocumentFragment();
  if (mobs.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'table-empty';
    cell.textContent = 'No tracked mobs found.';
    row.appendChild(cell);
    tbody.appendChild(row);
  } else {
    mobs
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .forEach((mob) => {
        const row = document.createElement('tr');
        const status = statusForMob(mob);
        row.innerHTML = `
          <td>${mob.name || ''}</td>
          <td>${[mob.zone, mob.expansion].filter(Boolean).join(' - ')}</td>
          <td>${formatAbsolute(mob.lastKillAt)}</td>
          <td>${formatRespawnRange(mob)}</td>
          <td><span class="status-chip ${status.className}">${status.text}</span></td>
        `;
        tbody.appendChild(row);
      });
  }

  tableBody.innerHTML = '';
  tableBody.appendChild(tbody);

  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Last updated ${generatedAt.toLocaleTimeString()}`;
  }
}

async function fetchAndRender() {
  if (!canViewMobWindows()) {
    return;
  }
  try {
    const response = await fetchWithAuth('/api/mob-windows', { method: 'GET', cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }
    const data = await response.json();
    const snapshot = data?.snapshot && Array.isArray(data.snapshot.mobs)
      ? data.snapshot
      : { generatedAt: data?.updatedAt || null, mobs: Array.isArray(data?.mobs) ? data.mobs : [] };
    renderLists(snapshot);
    dataLoaded = true;
  } catch (error) {
    console.error('Failed to load mob windows', error);
    const unauthorized = error && error.message === 'Unauthorized';
    const message = unauthorized
      ? 'Tracker access required to view mob windows.'
      : 'Failed to load mob windows. Please try again.';
    clearDisplays(message);
    if (unauthorized) {
      updateAuthUI(message);
    }
  }
}

refreshButton?.addEventListener('click', () => {
  if (!canViewMobWindows()) {
    updateAuthUI('Tracker access required to view mob windows.');
    return;
  }
  fetchAndRender();
});

authForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isSignedIn()) {
    return;
  }
  const username = authUsernameInput ? authUsernameInput.value.trim() : '';
  const password = authPasswordInput ? authPasswordInput.value : '';
  if (!username || !password) {
    updateAuthUI('Enter username and password.');
    return;
  }
  try {
    updateAuthUI('Signing in...');
    await authLogin(username, password);
    authState = getAuthState();
    updateAuthUI('Signed in.', { success: true });
  } catch (error) {
    updateAuthUI(error?.message || 'Login failed.');
  } finally {
    if (authPasswordInput) {
      authPasswordInput.value = '';
    }
  }
});

authLogoutButton?.addEventListener('click', async () => {
  if (!isSignedIn()) {
    return;
  }
  try {
    authLogoutButton.disabled = true;
    await authLogout();
    authState = getAuthState();
    updateAuthUI('Signed out.', { success: true });
  } catch (error) {
    updateAuthUI(error?.message || 'Failed to sign out.');
  } finally {
    authLogoutButton.disabled = false;
  }
});

onAuthChanged((next) => {
  authState = { ...authState, ...next };
  dataLoaded = false;
  updateAuthUI();
});

updateAuthUI();
