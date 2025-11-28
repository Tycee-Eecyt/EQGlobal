import { ROLE_LEVELS, login as authLogin, logout as authLogout, onAuthChanged, getAuthState, isSignedIn } from './auth.js';

const authForm = document.getElementById('auth-form');
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authLoginButton = document.getElementById('auth-login-button');
const authLogoutButton = document.getElementById('auth-logout-button');
const authFeedback = document.getElementById('auth-feedback');
const authUserLabel = document.getElementById('auth-user-label');
const authRoleLabel = document.getElementById('auth-role-label');

let authState = getAuthState();

function destinationForRole() {
  const level = Number(authState?.user?.roleLevel);
  if (Number.isFinite(level)) {
    if (level <= ROLE_LEVELS.ADMIN) return '/admin.html';
    if (level <= ROLE_LEVELS.TRACKER) return '/mob-windows.html';
  }
  return '/login.html';
}

function goIfSignedIn() {
  if (isSignedIn()) {
    window.location.replace(destinationForRole());
  }
}

function setAuthFeedback(message, { success = false } = {}) {
  if (!authFeedback) return;
  if (!message) {
    authFeedback.textContent = '';
    authFeedback.classList.remove('success');
    return;
  }
  authFeedback.textContent = message;
  authFeedback.classList.toggle('success', success);
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

  if (message !== null) {
    setAuthFeedback(message, options);
  } else {
    setAuthFeedback('');
  }
}

authForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isSignedIn()) {
    goIfSignedIn();
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
    goIfSignedIn();
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
  updateAuthUI();
  goIfSignedIn();
});

updateAuthUI();
goIfSignedIn();
