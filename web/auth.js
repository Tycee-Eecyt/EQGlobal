const STORAGE_KEY = 'eqglobal.auth';
const AUTH_REFRESH_GRACE_MS = 60_000;

export const ROLE_LEVELS = Object.freeze({
  ADMIN: 1,
  OFFICER: 2,
  TRACKER: 3,
  BASE: 4,
});

function defaultState() {
  return {
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  };
}

function loadPersistedState() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultState();
    }
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
  } catch (_err) {
    return defaultState();
  }
}

let authState = loadPersistedState();
const listeners = new Set();

function persistState() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(authState));
  } catch (_err) {
    // ignore storage errors
  }
}

function sanitizeState(state = authState) {
  return {
    user: state.user || null,
    accessTokenExpiresAt: state.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: state.refreshTokenExpiresAt || null,
  };
}

function notifyListeners() {
  const snapshot = sanitizeState();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (_err) {
      // swallow listener errors
    }
  });
}

function updateState(nextState) {
  authState = {
    ...defaultState(),
    ...(nextState && typeof nextState === 'object' ? nextState : {}),
  };
  persistState();
  notifyListeners();
}

function clearState() {
  authState = defaultState();
  persistState();
  notifyListeners();
}

function parseExpiry(value) {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isExpiringSoon(expiresAt) {
  const ts = parseExpiry(expiresAt);
  if (!ts) {
    return false;
  }
  return ts - Date.now() < AUTH_REFRESH_GRACE_MS;
}

function ensureRefreshValidity() {
  const refreshExpiry = parseExpiry(authState.refreshTokenExpiresAt);
  if (refreshExpiry && refreshExpiry <= Date.now()) {
    clearState();
  }
}

ensureRefreshValidity();

export function onAuthChanged(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }
  listeners.add(callback);
  callback(sanitizeState());
  return () => listeners.delete(callback);
}

export function getAuthState() {
  return sanitizeState();
}

export function isSignedIn() {
  return Boolean(authState.user);
}

export function hasRoleAtMost(level) {
  const roleLevel = Number(authState?.user?.roleLevel);
  return Number.isFinite(roleLevel) && roleLevel <= level;
}

export function requireRoleAtMost(level) {
  if (!hasRoleAtMost(level)) {
    throw new Error('Forbidden');
  }
}

export async function login(username, password) {
  const body = { username, password };
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = 'Login failed.';
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      }
    } catch (_err) {}
    throw new Error(message);
  }
  const data = await response.json();
  updateState({
    user: data.user || null,
    accessToken: data.accessToken || null,
    accessTokenExpiresAt: data.accessTokenExpiresAt || null,
    refreshToken: data.refreshToken || null,
    refreshTokenExpiresAt: data.refreshTokenExpiresAt || null,
  });
  return sanitizeState();
}

export async function logout() {
  clearState();
  return sanitizeState();
}

export async function refreshAccessToken({ silent = false } = {}) {
  if (!authState.refreshToken) {
    if (silent) {
      return null;
    }
    throw new Error('No refresh token available.');
  }
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: authState.refreshToken }),
  });
  if (!response.ok) {
    clearState();
    if (silent) {
      return null;
    }
    let message = 'Failed to refresh session.';
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      }
    } catch (_err) {}
    throw new Error(message);
  }
  const data = await response.json();
  updateState({
    user: data.user || authState.user || null,
    accessToken: data.accessToken || null,
    accessTokenExpiresAt: data.accessTokenExpiresAt || null,
    refreshToken: data.refreshToken || authState.refreshToken || null,
    refreshTokenExpiresAt: data.refreshTokenExpiresAt || authState.refreshTokenExpiresAt || null,
  });
  return authState.accessToken;
}

export async function getAccessToken({ silent = false } = {}) {
  if (!authState.accessToken) {
    return refreshAccessToken({ silent });
  }
  if (isExpiringSoon(authState.accessTokenExpiresAt)) {
    const refreshed = await refreshAccessToken({ silent: true });
    if (refreshed) {
      return refreshed;
    }
  }
  if (silent && !authState.accessToken) {
    return null;
  }
  if (!authState.accessToken) {
    throw new Error('Not authenticated.');
  }
  return authState.accessToken;
}

export async function fetchWithAuth(url, options = {}, { retry = true } = {}) {
  const token = await getAccessToken({ silent: true });
  if (!token) {
    throw new Error('Not authenticated.');
  }
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...options, headers });
  if ((response.status === 401 || response.status === 403) && retry) {
    clearState();
    throw new Error('Unauthorized');
  }
  return response;
}

export async function ensureAuthenticated() {
  const token = await getAccessToken({ silent: true });
  return Boolean(token);
}
