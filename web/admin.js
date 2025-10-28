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

let triggerCache = [];

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
  try {
    const res = await fetch('/api/log-triggers', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    triggerCache = Array.isArray(data?.triggers) ? data.triggers : [];
    renderRows(triggerCache);
  } catch (err) {
    console.error('Failed to load triggers', err);
    triggerCache = [];
    renderRows(triggerCache);
  }
}

async function saveTrigger(payload) {
  const method = payload.id ? 'PUT' : 'POST';
  const url = payload.id ? `/api/log-triggers/${encodeURIComponent(payload.id)}` : '/api/log-triggers';
  const body = payload.id ? { ...payload } : { ...payload };
  if (method === 'PUT') delete body.id;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function deleteTrigger(id) {
  const res = await fetch(`/api/log-triggers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

addBtn?.addEventListener('click', () => {
  clearEditor();
  fLabel.focus();
});

refreshBtn?.addEventListener('click', () => {
  loadTriggers();
});

tableBody?.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.getAttribute('data-action');
  const id = target.getAttribute('data-id');
  if (!action || !id) return;

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
  try {
    const res = await fetch('/api/log-triggers:test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

loadTriggers();

