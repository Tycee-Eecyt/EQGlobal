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

const tableBody = document.querySelector('#triggers-table tbody');
const addBtn = document.getElementById('add-trigger-btn');
const refreshBtn = document.getElementById('refresh-triggers-btn');

const form = document.getElementById('trigger-form');
const fId = document.getElementById('t-id');
const fLabel = document.getElementById('t-label');
const fPattern = document.getElementById('t-pattern');
const fIsRegex = document.getElementById('t-isRegex');
const fFlags = document.getElementById('t-flags');
const fEnabled = document.getElementById('t-enabled');
const fDesc = document.getElementById('t-desc');
const delBtn = document.getElementById('t-delete');
const clearBtn = document.getElementById('t-clear');

const testLine = document.getElementById('test-line');
const testBtn = document.getElementById('run-test');
const testResult = document.getElementById('test-result');
const authForm = document.getElementById('auth-form');
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authLoginButton = document.getElementById('auth-login-button');
const authLogoutButton = document.getElementById('auth-logout-button');
const authFeedback = document.getElementById('auth-feedback');
const authUserLabel = document.getElementById('auth-user-label');
const authRoleLabel = document.getElementById('auth-role-label');

let triggerCache = [];
let authState = getAuthState();
let triggersLoaded = false;

function isAuthorized() {
  return hasRoleAtMost(ROLE_LEVELS.ADMIN);
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

function setControlsDisabled(disabled) {
  [addBtn, refreshBtn, delBtn, clearBtn, testBtn].forEach((btn) => {
    if (btn) {
      btn.disabled = disabled;
    }
  });
  if (form) {
    const elements = form.querySelectorAll('input, button, select, textarea');
    elements.forEach((el) => {
      if (el === authUsernameInput || el === authPasswordInput || el === authLoginButton || el === authLogoutButton) {
        return;
      }
      el.disabled = disabled;
    });
  }
}

function showUnauthorizedTableMessage() {
  if (!tableBody) {
    return;
  }
  tableBody.innerHTML = '<tr><td class="table-empty" colspan="6">Admin access required.</td></tr>';
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

  const authorized = isAuthorized();
  setControlsDisabled(!authorized);
  if (authorized) {
    if (!triggersLoaded) {
      triggersLoaded = true;
      loadTriggers();
    }
    if (message !== null) {
      setAuthFeedback(message, options);
    } else {
      setAuthFeedback('');
    }
  } else {
    triggersLoaded = false;
    triggerCache = [];
    showUnauthorizedTableMessage();
    const feedbackMessage = message !== null ? message : 'Admin access required.';
    setAuthFeedback(feedbackMessage, options);
  }
}

function setEditor(trigger) {
  fId.value = trigger?.id || '';
  fLabel.value = trigger?.label || '';
  fPattern.value = trigger?.pattern || '';
  fIsRegex.checked = Boolean(trigger?.isRegex);
  fFlags.value = trigger?.flags || 'i';
  fEnabled.checked = trigger?.enabled !== false;
  fDesc.value = trigger?.description || '';
}

function clearEditor() {
  setEditor({ id: '', label: '', pattern: '', isRegex: false, flags: 'i', enabled: true, description: '' });
}

function renderRows(list = []) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(list) || list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'table-empty';
    td.textContent = 'No triggers configured.';
    tr.appendChild(td);
    frag.appendChild(tr);
  } else {
    list.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" ${t.enabled !== false ? 'checked' : ''} data-action="toggle" data-id="${t.id}"></td>
        <td>${escapeHtml(t.label || t.id)}</td>
        <td><code>${escapeHtml(t.pattern)}</code></td>
        <td>${t.isRegex ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(t.flags || '')}</td>
        <td>
          <button data-action="edit" data-id="${t.id}">Edit</button>
        </td>
      `;
      frag.appendChild(tr);
    });
  }
  tableBody.innerHTML = '';
  tableBody.appendChild(frag);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadTriggers() {
  if (!isAuthorized()) {
    showUnauthorizedTableMessage();
    return;
  }
  try {
    const res = await fetchWithAuth('/api/log-triggers', { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    triggerCache = Array.isArray(data?.triggers) ? data.triggers : [];
    renderRows(triggerCache);
  } catch (err) {
    console.error('Failed to load triggers', err);
    triggerCache = [];
    renderRows(triggerCache);
    if (err && err.message === 'Unauthorized') {
      updateAuthUI('Admin access required.');
    }
  }
}

async function saveTrigger(payload) {
  const method = payload.id ? 'PUT' : 'POST';
  const url = payload.id ? `/api/log-triggers/${encodeURIComponent(payload.id)}` : '/api/log-triggers';
  const body = payload.id ? { ...payload } : { ...payload };
  if (method === 'PUT') delete body.id;
  const res = await fetchWithAuth(url, {
    method,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function deleteTrigger(id) {
  const res = await fetchWithAuth(`/api/log-triggers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

addBtn?.addEventListener('click', () => {
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }
  clearEditor();
  fLabel.focus();
});

refreshBtn?.addEventListener('click', () => {
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }
  loadTriggers();
});

tableBody?.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.getAttribute('data-action');
  const id = target.getAttribute('data-id');
  if (!action || !id) return;
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }

  if (action === 'edit') {
    const t = triggerCache.find((x) => String(x.id) === id);
    if (t) setEditor(t);
  }
});

tableBody?.addEventListener('change', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  const action = target.getAttribute('data-action');
  const id = target.getAttribute('data-id');
  if (action === 'toggle' && id) {
    if (!isAuthorized()) {
      updateAuthUI('Admin access required.');
      return;
    }
    try {
      await saveTrigger({ id, enabled: target.checked });
      await loadTriggers();
    } catch (err) {
      console.error('Failed to toggle', err);
    }
  }
});

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }
  const payload = {
    id: fId.value.trim() || undefined,
    label: fLabel.value.trim(),
    pattern: fPattern.value.trim(),
    isRegex: fIsRegex.checked,
    flags: fFlags.value.trim(),
    enabled: fEnabled.checked,
    description: fDesc.value.trim(),
  };
  try {
    await saveTrigger(payload);
    clearEditor();
    await loadTriggers();
  } catch (err) {
    console.error('Failed to save trigger', err);
  }
});

delBtn?.addEventListener('click', async () => {
  const id = fId.value.trim();
  if (!id) return;
  if (!confirm('Delete this trigger?')) return;
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }
  try {
    await deleteTrigger(id);
    clearEditor();
    await loadTriggers();
  } catch (err) {
    console.error('Failed to delete trigger', err);
  }
});

clearBtn?.addEventListener('click', () => clearEditor());

testBtn?.addEventListener('click', async () => {
  const text = testLine.value || '';
  if (!text.trim()) {
    testResult.classList.add('empty');
    testResult.textContent = 'Enter a sample log line to test.';
    return;
  }
  if (!isAuthorized()) {
    updateAuthUI('Admin access required.');
    return;
  }
  try {
    const res = await fetchWithAuth('/api/log-triggers:test', {
      method: 'POST',
      body: JSON.stringify({ line: text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const matched = Array.isArray(data?.matched) ? data.matched : [];
    if (matched.length === 0) {
      testResult.classList.remove('success');
      testResult.classList.add('empty');
      testResult.textContent = 'No triggers matched.';
    } else {
      testResult.classList.remove('empty');
      testResult.textContent = `Matched: ${matched.join(', ')}`;
    }
  } catch (err) {
    console.error('Test failed', err);
    testResult.classList.add('empty');
    testResult.textContent = 'Test failed.';
  }
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
  triggersLoaded = false;
  updateAuthUI();
});

updateAuthUI();

