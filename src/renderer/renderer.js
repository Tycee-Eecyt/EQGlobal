
const STATUS_COLORS = {
  watching: '#49d1a4',
  stopped: '#ff6b6b',
  error: '#ff9f43',
  idle: '#7d8597',
};

const ROOT_CATEGORY_ID = 'root';
const DEFAULT_TRIGGER_DURATION = 30;

let triggers = [];
let categories = [];
let selectedNode = null;
let expandedCategories = new Set([ROOT_CATEGORY_ID]);
let activeTriggerTab = 'basic';
let timersRaf = null;
let recentLines = [];
let mobWindowSnapshot = { generatedAt: null, mobs: [] };

const logDirectoryInput = document.getElementById('log-directory');
const chooseLogDirButton = document.getElementById('choose-log-dir');
const backendUrlInput = document.getElementById('backend-url');
const overlayOpacityInput = document.getElementById('overlay-opacity');
const overlayOpacityValue = document.getElementById('overlay-opacity-value');
const overlayClickThroughInput = document.getElementById('overlay-clickthrough');
const watcherStatus = document.getElementById('watcher-status');
const triggerTreeContainer = document.getElementById('trigger-tree');
const triggerDetailContainer = document.getElementById('trigger-detail');
const activeTimersContainer = document.getElementById('active-timers');
const recentLinesList = document.getElementById('recent-lines');
const toggleMoveModeButton = document.getElementById('toggle-move-mode');
const showMobOverlayButton = document.getElementById('show-mob-overlay');
const mobWindowCurrentContainer = document.getElementById('mob-window-current');
const mobWindowUpcomingContainer = document.getElementById('mob-window-upcoming');
const mobWindowTableContainer = document.getElementById('mob-window-table');
let overlayMoveMode = false;
let draggedTriggerId = null;
let currentDropTarget = null;

const viewButtons = Array.from(document.querySelectorAll('[data-view-target]'));
const views = Array.from(document.querySelectorAll('.view'));
const watcherDirectorySummary = document.getElementById('watcher-directory-summary');
const headerStartStopButton = document.getElementById('header-start-stop');
let currentView = 'dashboard';

let categoryMap = new Map();

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

function createId(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36);
  return `${prefix}-${random}-${time}`;
}

function switchView(nextView) {
  if (!nextView) {
    return;
  }
  const targetView = views.find((view) => view.dataset.view === nextView);
  if (!targetView) {
    return;
  }

  views.forEach((view) => {
    view.classList.toggle('active', view === targetView);
  });
  viewButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.viewTarget === nextView);
  });

  currentView = nextView;

  if (nextView === 'settings') {
    setTimeout(() => {
      logDirectoryInput?.focus();
    }, 50);
  }
}

function updateDirectorySummary(directory) {
  if (!watcherDirectorySummary) {
    return;
  }
  const trimmed = (directory || '').trim();
  watcherDirectorySummary.textContent = trimmed || 'Not configured';
  watcherDirectorySummary.title = trimmed || '';
}

function normalizeCategories(rawCategories = []) {
  const normalized = [];
  const seen = new Set();
  for (const raw of rawCategories) {
    if (!raw) continue;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId('cat');
    if (seen.has(id)) continue;
    const parentId =
      typeof raw.parentId === 'string' && raw.parentId.trim() ? raw.parentId.trim() : null;
    const name =
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled Category';
    normalized.push({ id, name, parentId });
    seen.add(id);
  }

  const validIds = new Set(normalized.map((cat) => cat.id));
  for (const cat of normalized) {
    if (cat.parentId && !validIds.has(cat.parentId)) {
      cat.parentId = null;
    }
  }
  return normalized;
}

function rebuildCategoryCaches() {
  categoryMap = new Map(categories.map((cat) => [cat.id, cat]));
}

function getCategoryById(id) {
  if (!id) return null;
  return categoryMap.get(id) || null;
}

function getCategoryChildren(id) {
  return categories.filter((cat) => cat.parentId === id);
}

function categoryHasChildren(id) {
  return categories.some((cat) => cat.parentId === id);
}

function categoryHasTriggers(id) {
  return triggers.some((trigger) => trigger.categoryId === id);
}

function getDescendantCategoryIds(id) {
  const result = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = getCategoryChildren(current);
    for (const child of children) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

function ensureCategoryPath(pathSegments = []) {
  const cleaned = pathSegments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : null))
    .filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }

  let parentId = null;
  for (const segment of cleaned) {
    let existing = categories.find(
      (cat) => cat.parentId === parentId && cat.name.toLowerCase() === segment.toLowerCase()
    );
    if (!existing) {
      existing = { id: createId('cat'), name: segment, parentId };
      categories.push(existing);
    }
    parentId = existing.id;
  }

  rebuildCategoryCaches();
  return parentId;
}

function getCategoryPath(id) {
  if (!id) {
    return [];
  }

  const path = [];
  const visited = new Set();
  let current = id;

  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const category = getCategoryById(current);
    if (!category) break;
    path.unshift(category.name);
    current = category.parentId || null;
  }

  return path;
}

function getCategoryDisplayName(id) {
  const path = getCategoryPath(id);
  return path.length > 0 ? path.join(' › ') : '';
}

function getCategoryOptions({ includeRoot = false, exclude = [] } = {}) {
  const excludeSet = new Set(exclude);
  const options = [];
  if (includeRoot) {
    options.push({ id: '', label: 'Top Level' });
  }

  const list = categories
    .filter((cat) => !excludeSet.has(cat.id))
    .map((cat) => ({
      id: cat.id,
      label: getCategoryDisplayName(cat.id) || cat.name,
    }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'accent', numeric: true })
    );

  options.push(...list);
  return options;
}

function ensureDurationSeconds(durationSeconds, durationMs, fallback) {
  const numericSeconds = Number(durationSeconds);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return numericSeconds;
  }
  const numericMs = Number(durationMs);
  if (Number.isFinite(numericMs) && numericMs >= 0) {
    return numericMs / 1000;
  }
  const numericFallback = Number(fallback);
  if (Number.isFinite(numericFallback) && numericFallback >= 0) {
    return numericFallback;
  }
  return DEFAULT_TRIGGER_DURATION;
}

function normalizeTextSettings(raw = {}) {
  return {
    display: Boolean(raw.display),
    displayText: typeof raw.displayText === 'string' ? raw.displayText : '',
    clipboard: Boolean(raw.clipboard),
    clipboardText: typeof raw.clipboardText === 'string' ? raw.clipboardText : '',
  };
}

function normalizeAudioSettings(raw = {}) {
  const mode = (() => {
    if (raw.mode === 'tts' || raw.mode === 'file' || raw.mode === 'none') {
      return raw.mode;
    }
    if (raw.useTextToSpeech) return 'tts';
    if (raw.playSoundFile) return 'file';
    return 'none';
  })();

  return {
    mode,
    text: typeof raw.text === 'string' ? raw.text : raw.textToSay || '',
    interrupt: Boolean(raw.interrupt || raw.interruptSpeech),
    soundFile: typeof raw.soundFile === 'string' ? raw.soundFile : raw.file || '',
    voice: typeof raw.voice === 'string' ? raw.voice : '',
  };
}

function normalizeEndEarlyEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { id: createId('end'), text: entry, useRegex: false };
  }
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!text.trim()) return null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : createId('end'),
    text,
    useRegex: Boolean(entry.useRegex || entry.isRegex),
  };
}

function normalizeTimer(raw = {}, trigger = {}) {
  const durationSeconds = ensureDurationSeconds(
    raw.durationSeconds,
    raw.durationMs,
    trigger.duration
  );
  const entries = Array.isArray(raw.endEarlyTexts)
    ? raw.endEarlyTexts.map(normalizeEndEarlyEntry).filter(Boolean)
    : [];
  return {
    type: raw.type === 'countup' ? 'countup' : 'countdown',
    name: typeof raw.name === 'string' ? raw.name : trigger.label || trigger.pattern || '',
    durationSeconds,
    restartMode: raw.restartMode || 'restart-current',
    endEarlyTexts: entries,
  };
}

function normalizeTimerEnding(raw = {}) {
  return {
    enabled: Boolean(raw.enabled),
    thresholdSeconds: ensureDurationSeconds(raw.thresholdSeconds, raw.thresholdMs, 1),
    textSettings: normalizeTextSettings(raw.textSettings),
    audio: normalizeAudioSettings(raw.audio),
  };
}

function normalizeTimerEnded(raw = {}) {
  return {
    enabled: Boolean(raw.enabled),
    textSettings: normalizeTextSettings(raw.textSettings),
    audio: normalizeAudioSettings(raw.audio),
  };
}

function normalizeCounter(raw = {}) {
  return {
    enabled: Boolean(raw.enabled),
    resetSeconds: ensureDurationSeconds(raw.resetSeconds, raw.resetMs, 0),
  };
}

function normalizeTrigger(raw = {}) {
  const trigger = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId('trigger'),
    label:
      typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.pattern || 'New Trigger',
    pattern: typeof raw.pattern === 'string' ? raw.pattern : '',
    duration: ensureDurationSeconds(raw.duration, null, DEFAULT_TRIGGER_DURATION),
    color: typeof raw.color === 'string' && raw.color ? raw.color : '#00c9ff',
    isRegex: Boolean(raw.isRegex),
    comments: typeof raw.comments === 'string' ? raw.comments : '',
    textSettings: normalizeTextSettings(raw.textSettings || raw.basicText),
    audio: normalizeAudioSettings(raw.audio || raw.audioSettings),
    timer: normalizeTimer(raw.timer || {}, raw),
    timerEnding: normalizeTimerEnding(raw.timerEnding || {}),
    timerEnded: normalizeTimerEnded(raw.timerEnded || {}),
    counter: normalizeCounter(raw.counter || {}),
    categoryId: typeof raw.categoryId === 'string' && raw.categoryId.trim() ? raw.categoryId.trim() : null,
    categoryPath: Array.isArray(raw.categoryPath) ? raw.categoryPath.filter(Boolean) : [],
  };

  trigger.duration = Math.max(
    1,
    Math.round(trigger.timer.durationSeconds || trigger.duration || DEFAULT_TRIGGER_DURATION)
  );
  trigger.timer.durationSeconds = trigger.duration;
  return trigger;
}

function normalizeTriggers(rawTriggers = []) {
  const normalized = [];
  for (const raw of rawTriggers) {
    const trigger = normalizeTrigger(raw || {});
    let categoryId = null;

    if (trigger.categoryId && getCategoryById(trigger.categoryId)) {
      categoryId = trigger.categoryId;
    } else if (Array.isArray(trigger.categoryPath) && trigger.categoryPath.length > 0) {
      categoryId = ensureCategoryPath(trigger.categoryPath);
    } else if (typeof raw.category === 'string' && raw.category.trim()) {
      const segments = raw.category
        .split(/[\\/›>]/g)
        .map((segment) => segment.trim())
        .filter(Boolean);
      categoryId = ensureCategoryPath(segments);
    }

    trigger.categoryId = categoryId;
    updateDerivedTriggerFields(trigger);
    normalized.push(trigger);
  }

  return normalized;
}

function updateDerivedTriggerFields(trigger) {
  rebuildCategoryCaches();
  trigger.categoryPath = getCategoryPath(trigger.categoryId);
  trigger.category = trigger.categoryPath.length > 0 ? trigger.categoryPath.join(' › ') : '';
  trigger.duration = Math.max(
    1,
    Math.round(trigger.timer.durationSeconds || trigger.duration || DEFAULT_TRIGGER_DURATION)
  );
  trigger.timer.durationSeconds = trigger.duration;
}

function updateAllDerivedTriggerFields() {
  triggers.forEach((trigger) => updateDerivedTriggerFields(trigger));
}

function buildCategoryTree() {
  rebuildCategoryCaches();
  const nodes = new Map();

  for (const cat of categories) {
    nodes.set(cat.id, {
      ...cat,
      type: 'category',
      children: [],
    });
  }

  const root = { id: ROOT_CATEGORY_ID, name: 'All Triggers', type: 'root', children: [] };

  for (const cat of categories) {
    const node = nodes.get(cat.id);
    const parent = (cat.parentId && nodes.get(cat.parentId)) || root;
    parent.children.push(node);
  }

  for (const trigger of triggers) {
    const parent = (trigger.categoryId && nodes.get(trigger.categoryId)) || root;
    parent.children.push({
      type: 'trigger',
      id: trigger.id,
      name: trigger.label || trigger.pattern || 'Unnamed Trigger',
      trigger,
    });
  }

  const sortChildren = (node) => {
    if (!Array.isArray(node.children)) return;
    node.children.sort((a, b) => {
      if (a.type === 'category' && b.type !== 'category') return -1;
      if (a.type !== 'category' && b.type === 'category') return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    node.children.forEach(sortChildren);
  };

sortChildren(root);
  return root;
}

function getDropTargetElement(element) {
  if (!element) return null;
  return element.closest('[data-drop-target]');
}

function clearCurrentDropTarget() {
  if (currentDropTarget) {
    currentDropTarget.classList.remove('drag-over');
    currentDropTarget = null;
  }
}

function renderTreeNode(node) {
  if (node.type === 'trigger') {
    const isSelected = selectedNode && selectedNode.type === 'trigger' && selectedNode.id === node.id;
    return `
      <li>
        <div class="tree-item trigger ${isSelected ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="trigger" role="treeitem" aria-selected="${isSelected}" draggable="true" data-drag-type="trigger">
          <span class="tree-toggle-placeholder"></span>
          <span class="tree-icon trigger"></span>
          <span class="tree-label">${escapeHtml(node.name)}</span>
        </div>
      </li>
    `;
  }

  const isExpanded = expandedCategories.has(node.id);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isSelected = selectedNode && selectedNode.type === 'category' && selectedNode.id === node.id;

  const toggle = hasChildren
    ? `<button class="tree-toggle" data-action="toggle-category" data-category-id="${node.id}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} category">${isExpanded ? '▾' : '▸'}</button>`
    : `<span class="tree-toggle-placeholder"></span>`;

  const childrenMarkup =
    hasChildren && isExpanded
      ? `<ul class="tree-children" role="group">${node.children.map((child) => renderTreeNode(child)).join('')}</ul>`
      : '';

  return `
    <li>
      <div class="tree-item category ${isSelected ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="category" role="treeitem" aria-expanded="${isExpanded}" aria-selected="${isSelected}" data-drop-target="category" data-category-id="${node.id}">
        ${toggle}
        <span class="tree-icon folder"></span>
        <span class="tree-label">${escapeHtml(node.name)}</span>
      </div>
      ${childrenMarkup}
    </li>
  `;
}

function ensureSelectionValid() {
  if (!selectedNode) return;
  if (selectedNode.type === 'trigger') {
    if (!triggers.some((trigger) => trigger.id === selectedNode.id)) {
      selectedNode = null;
    }
  } else if (selectedNode.type === 'category') {
    if (!categories.some((category) => category.id === selectedNode.id)) {
      selectedNode = null;
    }
  }
  if (!selectedNode) {
    selectFirstAvailableNode();
  }
}

function renderTriggerTree() {
  ensureSelectionValid();
  const root = buildCategoryTree();
  if (!root.children || root.children.length === 0) {
    triggerTreeContainer.innerHTML =
      '<p class="empty-note">No triggers yet. Add a category or trigger to get started.</p>';
    return;
  }

  triggerTreeContainer.innerHTML = `
    <div class="tree-item category root-drop" data-node-type="root" data-drop-target="root" role="treeitem" aria-label="All triggers">
      <span class="tree-toggle-placeholder"></span>
      <span class="tree-icon folder root"></span>
      <span class="tree-label">All Triggers</span>
    </div>
    <ul class="tree-root" role="tree">${root.children.map((node) => renderTreeNode(node)).join('')}</ul>`;
}

function splitDuration(seconds = 0) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return { hours, minutes, seconds: secs };
}

function combineDuration({ hours = 0, minutes = 0, seconds = 0 } = {}) {
  const safe = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
  return safe(hours) * 3600 + safe(minutes) * 60 + safe(seconds);
}

function renderDurationInputs(parts, { targetField, minimumSeconds = 0 }) {
  return `
    <div class="duration-inputs" data-duration-group="${targetField}" data-minimum="${minimumSeconds}">
      <input type="number" min="0" step="1" value="${parts.hours}" data-role="duration-field" data-target="${targetField}" data-part="hours" aria-label="Hours" />
      <span>h</span>
      <input type="number" min="0" max="59" step="1" value="${parts.minutes}" data-role="duration-field" data-target="${targetField}" data-part="minutes" aria-label="Minutes" />
      <span>m</span>
      <input type="number" min="0" max="59" step="1" value="${parts.seconds}" data-role="duration-field" data-target="${targetField}" data-part="seconds" aria-label="Seconds" />
      <span>s</span>
    </div>
  `;
}

function renderSoundFilePicker(fieldPath, value, enabled) {
  const displayText = value ? value : 'No file selected';
  const stateClass = enabled ? '' : ' disabled';
  return `
    <div class="sound-file-picker${stateClass}">
      <span class="sound-file-display ${value ? '' : 'empty'}" title="${escapeHtml(displayText)}">${escapeHtml(displayText)}</span>
      <button type="button" class="secondary small" data-action="browse-sound-file" data-field="${fieldPath}" ${enabled ? '' : 'disabled'}>Browse…</button>
    </div>
  `;
}

function showCategoryPrompt({ parentName = 'Top Level' } = {}) {
  return new Promise((resolve) => {
    if (document.querySelector('.modal-backdrop')) {
      resolve(null);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';

    const card = document.createElement('div');
    card.className = 'modal-card';

    const title = document.createElement('h3');
    title.textContent = 'New Category';

    const message = document.createElement('p');
    message.textContent = `Create a category under "${parentName}".`;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Category name';
    input.autocomplete = 'off';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'secondary';
    cancelButton.textContent = 'Cancel';

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'primary';
    confirmButton.textContent = 'Create';

    actions.append(cancelButton, confirmButton);
    card.append(title, message, input, actions);
    overlay.append(card);
    document.body.append(overlay);

    const cleanup = (value) => {
      overlay.remove();
      resolve(value || null);
    };

    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      cleanup(value);
    };

    confirmButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });

    input.focus();
  });
}

function renderTabButtons(tabs) {
  return tabs
    .map((tab) => {
      const isActive = activeTriggerTab === tab;
      const labelMap = {
        basic: 'Basic',
        timer: 'Timer',
        timerEnding: 'Timer Ending',
        timerEnded: 'Timer Ended',
        counter: 'Counter',
      };
      return `<button class="tab-button ${isActive ? 'active' : ''}" data-action="select-tab" data-tab="${tab}" role="tab" aria-selected="${isActive}">${labelMap[tab] || tab}</button>`;
    })
    .join('');
}

function renderBasicTab(trigger, categoryOptions) {
  const textSettings = trigger.textSettings || {
    display: false,
    displayText: '',
    clipboard: false,
    clipboardText: '',
  };
  const audioSettings = trigger.audio || {
    mode: 'none',
    text: '',
    interrupt: false,
    soundFile: '',
  };
  const audioMode = audioSettings.mode || 'none';
  const audioFields = [];
  if (audioMode === 'tts') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Text To Say</label>
        <input type="text" value="${escapeHtml(audioSettings.text || '')}" data-role="trigger-field" data-field="audio.text" />
      </div>
      <div class="editor-field audio-field">
        <label class="checkbox-row">
          <input type="checkbox" data-role="trigger-field" data-field="audio.interrupt" data-type="boolean" ${audioSettings.interrupt ? 'checked' : ''} />
          Interrupt Speech
        </label>
      </div>
    `);
  }
  if (audioMode === 'file') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Sound File</label>
        ${renderSoundFilePicker('audio.soundFile', audioSettings.soundFile, true)}
      </div>
    `);
  }
  const audioFieldsMarkup = audioFields.join('');

  const categoryOptionsMarkup = categoryOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}" ${
          (trigger.categoryId || '') === option.id ? 'selected' : ''
        }>${escapeHtml(option.label)}</option>`
    )
    .join('');

  return `
    <div class="tab-content ${activeTriggerTab === 'basic' ? 'active' : ''}" data-tab="basic" role="tabpanel">
      <div class="editor-grid">
        <div class="editor-field">
          <label for="trigger-label">Trigger Name</label>
          <input id="trigger-label" type="text" value="${escapeHtml(trigger.label || '')}" data-role="trigger-field" data-field="label" autocomplete="off" />
        </div>
        <div class="editor-field">
          <label for="trigger-pattern">Search Text</label>
          <input id="trigger-pattern" type="text" value="${escapeHtml(trigger.pattern || '')}" data-role="trigger-field" data-field="pattern" autocomplete="off" />
        </div>
        <div class="editor-field">
          <label for="trigger-category">Category</label>
          <select id="trigger-category" data-role="trigger-field" data-field="categoryId">
            ${categoryOptionsMarkup}
          </select>
        </div>
        <div class="editor-field">
          <label for="trigger-color">Color</label>
          <input id="trigger-color" type="color" value="${escapeHtml(trigger.color || '#00c9ff')}" data-role="trigger-field" data-field="color" />
        </div>
        <div class="editor-field">
          <label for="trigger-comments">Comments</label>
          <textarea id="trigger-comments" data-role="trigger-field" data-field="comments" rows="3">${escapeHtml(trigger.comments || '')}</textarea>
        </div>
        <div class="editor-field">
          <div class="checkbox-row">
            <input id="trigger-regex" type="checkbox" data-role="trigger-field" data-field="isRegex" data-type="boolean" ${trigger.isRegex ? 'checked' : ''} />
            <label for="trigger-regex">Use Regular Expressions</label>
          </div>
        </div>
      </div>

      <div class="editor-section">
        <h4>Text Settings</h4>
        <div class="checkbox-group">
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="textSettings.display" data-type="boolean" ${textSettings.display ? 'checked' : ''} />
            Display Text
          </label>
          <input type="text" placeholder="Displayed text" value="${escapeHtml(textSettings.displayText || '')}" data-role="trigger-field" data-field="textSettings.displayText" ${textSettings.display ? '' : 'disabled'} />
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="textSettings.clipboard" data-type="boolean" ${textSettings.clipboard ? 'checked' : ''} />
            Clipboard Text
          </label>
          <input type="text" placeholder="Clipboard text" value="${escapeHtml(textSettings.clipboardText || '')}" data-role="trigger-field" data-field="textSettings.clipboardText" ${textSettings.clipboard ? '' : 'disabled'} />
        </div>
      </div>

      <div class="editor-section">
        <h4>Audio Settings</h4>
        <div class="radio-group">
          <label class="radio-row">
            <input type="radio" name="basic-audio-${trigger.id}" data-role="trigger-field" data-field="audio.mode" value="none" ${audioSettings.mode === 'none' ? 'checked' : ''} />
            No Sound
          </label>
          <label class="radio-row">
            <input type="radio" name="basic-audio-${trigger.id}" data-role="trigger-field" data-field="audio.mode" value="tts" ${audioSettings.mode === 'tts' ? 'checked' : ''} />
            Use Text To Speech
          </label>
      <label class="radio-row">
        <input type="radio" name="basic-audio-${trigger.id}" data-role="trigger-field" data-field="audio.mode" value="file" ${audioSettings.mode === 'file' ? 'checked' : ''} />
        Play Sound File
      </label>
    </div>
    ${audioFieldsMarkup ? `<div class="editor-grid audio-grid">${audioFieldsMarkup}</div>` : ''}
  </div>
</div>
  `;
}

function renderEndEarlyRows(trigger) {
  const rows = Array.isArray(trigger.timer.endEarlyTexts) ? trigger.timer.endEarlyTexts : [];
  if (rows.length === 0) {
    return '<p class="empty-note">No early end text configured.</p>';
  }

  return `
    <div class="table-list">
      ${rows
        .map(
          (entry, index) => `
            <div class="table-row" data-entry-index="${index}" data-entry-id="${entry.id}">
              <input type="text" value="${escapeHtml(entry.text || '')}" data-role="trigger-field" data-field="timer.endEarlyTexts.${index}.text" />
              <label class="checkbox-row">
                <input type="checkbox" data-role="trigger-field" data-field="timer.endEarlyTexts.${index}.useRegex" data-type="boolean" ${entry.useRegex ? 'checked' : ''} />
                Regex
              </label>
              <button class="secondary small" type="button" data-action="remove-end-early" data-entry-id="${entry.id}">Remove</button>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderTimerTab(trigger, durationParts) {
  const timer = trigger.timer || { type: 'countdown', name: '', restartMode: 'restart-current' };
  return `
    <div class="tab-content ${activeTriggerTab === 'timer' ? 'active' : ''}" data-tab="timer" role="tabpanel">
      <div class="editor-grid">
        <div class="editor-field">
          <label>Timer Type</label>
          <select data-role="trigger-field" data-field="timer.type">
            <option value="countdown" ${timer.type === 'countdown' ? 'selected' : ''}>Timer (Count Down)</option>
            <option value="countup" ${timer.type === 'countup' ? 'selected' : ''}>Timer (Count Up)</option>
          </select>
        </div>
        <div class="editor-field">
          <label>Timer Name</label>
          <input type="text" value="${escapeHtml(timer.name || '')}" data-role="trigger-field" data-field="timer.name" />
        </div>
        <div class="editor-field">
          <label>Timer Duration</label>
          ${renderDurationInputs(durationParts, { targetField: 'timer.durationSeconds', minimumSeconds: 1 })}
        </div>
        <div class="editor-field">
          <label>If timer is already running when triggered again</label>
          <select data-role="trigger-field" data-field="timer.restartMode">
            <option value="restart-current" ${timer.restartMode === 'restart-current' ? 'selected' : ''}>Restart current timer</option>
            <option value="queue" ${timer.restartMode === 'queue' ? 'selected' : ''}>Queue another instance</option>
            <option value="ignore" ${timer.restartMode === 'ignore' ? 'selected' : ''}>Ignore new trigger</option>
          </select>
        </div>
      </div>
      <div class="editor-section">
        <h4>End Early Text</h4>
        ${renderEndEarlyRows(trigger)}
        <button class="secondary small" type="button" data-action="add-end-early">Add Text</button>
      </div>
    </div>
  `;
}

function renderTimerEndingTab(trigger, thresholdParts) {
  const timerEnding = trigger.timerEnding || { enabled: false, textSettings: {}, audio: {} };
  const textSettings = timerEnding.textSettings || {
    display: false,
    displayText: '',
    clipboard: false,
    clipboardText: '',
  };
  const audioSettings = timerEnding.audio || { mode: 'none', text: '', soundFile: '', interrupt: false };
  const audioMode = audioSettings.mode || 'none';
  const audioFields = [];
  if (audioMode === 'tts') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Text To Say</label>
        <input type="text" value="${escapeHtml(audioSettings.text || '')}" data-role="trigger-field" data-field="timerEnding.audio.text" />
      </div>
      <div class="editor-field audio-field">
        <label class="checkbox-row">
          <input type="checkbox" data-role="trigger-field" data-field="timerEnding.audio.interrupt" data-type="boolean" ${audioSettings.interrupt ? 'checked' : ''} />
          Interrupt Speech
        </label>
      </div>
    `);
  }
  if (audioMode === 'file') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Sound File</label>
        ${renderSoundFilePicker('timerEnding.audio.soundFile', audioSettings.soundFile, true)}
      </div>
    `);
  }
  const audioFieldsMarkup = audioFields.join('');

  return `
    <div class="tab-content ${activeTriggerTab === 'timerEnding' ? 'active' : ''}" data-tab="timerEnding" role="tabpanel">
      <div class="editor-section">
        <h4>Countdown Warning</h4>
        <div class="checkbox-group">
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="timerEnding.enabled" data-type="boolean" ${timerEnding.enabled ? 'checked' : ''} />
            Notify when timer is down to
          </label>
          ${renderDurationInputs(thresholdParts, { targetField: 'timerEnding.thresholdSeconds', minimumSeconds: 0 })}
        </div>
      </div>
      <div class="editor-section">
        <h4>Text Settings</h4>
        <div class="checkbox-group">
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="timerEnding.textSettings.display" data-type="boolean" ${textSettings.display ? 'checked' : ''} />
            Display Text
          </label>
          <input type="text" value="${escapeHtml(textSettings.displayText || '')}" data-role="trigger-field" data-field="timerEnding.textSettings.displayText" ${textSettings.display ? '' : 'disabled'} />
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="timerEnding.textSettings.clipboard" data-type="boolean" ${textSettings.clipboard ? 'checked' : ''} />
            Clipboard Text
          </label>
          <input type="text" value="${escapeHtml(textSettings.clipboardText || '')}" data-role="trigger-field" data-field="timerEnding.textSettings.clipboardText" ${textSettings.clipboard ? '' : 'disabled'} />
        </div>
      </div>
      <div class="editor-section">
        <h4>Audio Settings</h4>
        <div class="radio-group">
          <label class="radio-row">
            <input type="radio" name="timer-ending-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnding.audio.mode" value="none" ${audioSettings.mode === 'none' ? 'checked' : ''} />
            No Sound
          </label>
          <label class="radio-row">
            <input type="radio" name="timer-ending-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnding.audio.mode" value="tts" ${audioSettings.mode === 'tts' ? 'checked' : ''} />
            Use Text To Speech
          </label>
      <label class="radio-row">
        <input type="radio" name="timer-ending-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnding.audio.mode" value="file" ${audioSettings.mode === 'file' ? 'checked' : ''} />
        Play Sound File
      </label>
    </div>
    ${audioFieldsMarkup ? `<div class="editor-grid audio-grid">${audioFieldsMarkup}</div>` : ''}
  </div>
</div>
  `;
}

function renderTimerEndedTab(trigger) {
  const timerEnded = trigger.timerEnded || { enabled: false, textSettings: {}, audio: {} };
  const textSettings = timerEnded.textSettings || {
    display: false,
    displayText: '',
    clipboard: false,
    clipboardText: '',
  };
  const audioSettings = timerEnded.audio || { mode: 'none', text: '', soundFile: '', interrupt: false };
  const audioMode = audioSettings.mode || 'none';
  const audioFields = [];
  if (audioMode === 'tts') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Text To Say</label>
        <input type="text" value="${escapeHtml(audioSettings.text || '')}" data-role="trigger-field" data-field="timerEnded.audio.text" />
      </div>
      <div class="editor-field audio-field">
        <label class="checkbox-row">
          <input type="checkbox" data-role="trigger-field" data-field="timerEnded.audio.interrupt" data-type="boolean" ${audioSettings.interrupt ? 'checked' : ''} />
          Interrupt Speech
        </label>
      </div>
    `);
  }
  if (audioMode === 'file') {
    audioFields.push(`
      <div class="editor-field audio-field">
        <label>Sound File</label>
        ${renderSoundFilePicker('timerEnded.audio.soundFile', audioSettings.soundFile, true)}
      </div>
    `);
  }
  const audioFieldsMarkup = audioFields.join('');

  return `
    <div class="tab-content ${activeTriggerTab === 'timerEnded' ? 'active' : ''}" data-tab="timerEnded" role="tabpanel">
      <div class="editor-section">
        <h4>Timer Completed</h4>
        <label class="checkbox-row">
          <input type="checkbox" data-role="trigger-field" data-field="timerEnded.enabled" data-type="boolean" ${timerEnded.enabled ? 'checked' : ''} />
          Notify when timer ends
        </label>
      </div>
      <div class="editor-section">
        <h4>Text Settings</h4>
        <div class="checkbox-group">
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="timerEnded.textSettings.display" data-type="boolean" ${textSettings.display ? 'checked' : ''} />
            Display Text
          </label>
          <input type="text" value="${escapeHtml(textSettings.displayText || '')}" data-role="trigger-field" data-field="timerEnded.textSettings.displayText" ${textSettings.display ? '' : 'disabled'} />
          <label class="checkbox-row">
            <input type="checkbox" data-role="trigger-field" data-field="timerEnded.textSettings.clipboard" data-type="boolean" ${textSettings.clipboard ? 'checked' : ''} />
            Clipboard Text
          </label>
          <input type="text" value="${escapeHtml(textSettings.clipboardText || '')}" data-role="trigger-field" data-field="timerEnded.textSettings.clipboardText" ${textSettings.clipboard ? '' : 'disabled'} />
        </div>
      </div>
      <div class="editor-section">
        <h4>Audio Settings</h4>
        <div class="radio-group">
          <label class="radio-row">
            <input type="radio" name="timer-ended-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnded.audio.mode" value="none" ${audioSettings.mode === 'none' ? 'checked' : ''} />
            No Sound
          </label>
          <label class="radio-row">
            <input type="radio" name="timer-ended-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnded.audio.mode" value="tts" ${audioSettings.mode === 'tts' ? 'checked' : ''} />
            Use Text To Speech
          </label>
      <label class="radio-row">
        <input type="radio" name="timer-ended-audio-${trigger.id}" data-role="trigger-field" data-field="timerEnded.audio.mode" value="file" ${audioSettings.mode === 'file' ? 'checked' : ''} />
        Play Sound File
      </label>
    </div>
    ${audioFieldsMarkup ? `<div class="editor-grid audio-grid">${audioFieldsMarkup}</div>` : ''}
  </div>
</div>
  `;
}

function renderCounterTab(trigger, counterParts) {
  const counter = trigger.counter || { enabled: false, resetSeconds: 0 };
  return `
    <div class="tab-content ${activeTriggerTab === 'counter' ? 'active' : ''}" data-tab="counter" role="tabpanel">
      <div class="editor-section">
        <h4>Counter</h4>
        <label class="checkbox-row">
          <input type="checkbox" data-role="trigger-field" data-field="counter.enabled" data-type="boolean" ${counter.enabled ? 'checked' : ''} />
          Reset counter if unmatched for
        </label>
        ${renderDurationInputs(counterParts, { targetField: 'counter.resetSeconds', minimumSeconds: 0 })}
      </div>
    </div>
  `;
}

function renderTriggerEditor(trigger) {
  const durationParts = splitDuration(trigger.timer.durationSeconds);
  const timerEndingParts = splitDuration(trigger.timerEnding.thresholdSeconds);
  const counterParts = splitDuration(trigger.counter.resetSeconds);
  const categoryOptions = getCategoryOptions({ includeRoot: true });
  const heading = trigger.label || trigger.pattern || 'Trigger';

  return `
    <div class="trigger-editor">
      <div class="trigger-editor-header">
        <div>
          <h3 id="trigger-editor-title">${escapeHtml(heading)}</h3>
          <div class="trigger-editor-meta">
            <span>${escapeHtml(trigger.pattern || 'No search text configured')}</span>
            <span>${trigger.duration}s duration</span>
          </div>
        </div>
        <div class="editor-actions">
          <button class="secondary" type="button" data-action="duplicate-trigger" data-trigger-id="${trigger.id}">Duplicate</button>
          <button class="danger" type="button" data-action="delete-trigger" data-trigger-id="${trigger.id}">Delete</button>
        </div>
      </div>
      <div class="tab-strip" role="tablist">
        ${renderTabButtons(['basic', 'timer', 'timerEnding', 'timerEnded', 'counter'])}
      </div>
      ${renderBasicTab(trigger, categoryOptions)}
      ${renderTimerTab(trigger, durationParts)}
      ${renderTimerEndingTab(trigger, timerEndingParts)}
      ${renderTimerEndedTab(trigger)}
      ${renderCounterTab(trigger, counterParts)}
    </div>
  `;
}

function renderCategoryEditor(category) {
  const pathLabel = getCategoryDisplayName(category.id) || category.name;
  const descendants = getDescendantCategoryIds(category.id);
  const options = getCategoryOptions({ includeRoot: true, exclude: [category.id, ...descendants] });
  const canDelete = !categoryHasChildren(category.id) && !categoryHasTriggers(category.id);

  const optionsMarkup = options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}" ${option.id === (category.parentId || '') ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
    )
    .join('');

  return `
    <div class="trigger-editor">
      <div class="trigger-editor-header">
        <div>
          <h3>Category</h3>
          <div class="trigger-editor-meta">
            <span>${escapeHtml(pathLabel)}</span>
          </div>
        </div>
        <div class="editor-actions">
          <button class="danger" type="button" data-action="delete-category" data-category-id="${category.id}" ${canDelete ? '' : 'disabled'}>Delete</button>
        </div>
      </div>
      <div class="editor-section">
        <div class="editor-field">
          <label for="category-name">Name</label>
          <input id="category-name" type="text" value="${escapeHtml(category.name)}" data-role="category-field" data-field="name" />
        </div>
        <div class="editor-field">
          <label for="category-parent">Parent Category</label>
          <select id="category-parent" data-role="category-field" data-field="parentId">
            ${optionsMarkup}
          </select>
        </div>
        ${
          canDelete
            ? ''
            : '<p class="category-editor-note">Move or delete child categories and triggers before deleting this category.</p>'
        }
      </div>
    </div>
  `;
}

function renderTriggerDetail() {
  if (!selectedNode) {
    triggerDetailContainer.classList.add('empty');
    triggerDetailContainer.innerHTML = '<p>Select a category or trigger to edit its settings.</p>';
    return;
  }

  triggerDetailContainer.classList.remove('empty');

  if (selectedNode.type === 'category') {
    const category = getCategoryById(selectedNode.id);
    if (!category) {
      triggerDetailContainer.innerHTML = '<p class="empty-note">Category no longer exists.</p>';
      return;
    }
    triggerDetailContainer.innerHTML = renderCategoryEditor(category);
    return;
  }

  if (selectedNode.type === 'trigger') {
    const trigger = getTriggerById(selectedNode.id);
    if (!trigger) {
      triggerDetailContainer.innerHTML = '<p class="empty-note">Trigger no longer exists.</p>';
      return;
    }
    triggerDetailContainer.innerHTML = renderTriggerEditor(trigger);
    return;
  }

  triggerDetailContainer.innerHTML = '<p>Select a category or trigger to edit its settings.</p>';
}

function selectFirstAvailableNode() {
  if (triggers.length > 0) {
    selectedNode = { type: 'trigger', id: triggers[0].id };
    expandForCategory(triggers[0].categoryId);
    return;
  }
  if (categories.length > 0) {
    selectedNode = { type: 'category', id: categories[0].id };
    expandForCategory(categories[0].id);
    return;
  }
  selectedNode = null;
}

function expandForCategory(categoryId) {
  if (categoryId) {
    let current = categoryId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      expandedCategories.add(current);
      const category = getCategoryById(current);
      if (category && category.parentId) {
        current = category.parentId;
      } else {
        expandedCategories.add(ROOT_CATEGORY_ID);
        break;
      }
    }
  } else {
    expandedCategories.add(ROOT_CATEGORY_ID);
  }
}

function setSelectedNode(type, id) {
  if (type === 'trigger') {
    if (!triggers.some((trigger) => trigger.id === id)) {
      return;
    }
    selectedNode = { type: 'trigger', id };
    activeTriggerTab = 'basic';
    const trigger = getTriggerById(id);
    expandForCategory(trigger ? trigger.categoryId : null);
  } else if (type === 'category') {
    if (!categories.some((category) => category.id === id)) {
      return;
    }
    selectedNode = { type: 'category', id };
    activeTriggerTab = 'basic';
    expandForCategory(id);
  } else {
    selectedNode = null;
  }
  renderTriggerTree();
  renderTriggerDetail();
}

function toggleCategoryExpansion(categoryId) {
  if (expandedCategories.has(categoryId)) {
    expandedCategories.delete(categoryId);
  } else {
    expandedCategories.add(categoryId);
  }
  renderTriggerTree();
}

function getTriggerById(id) {
  return triggers.find((trigger) => trigger.id === id) || null;
}

async function handleAddCategory() {
  let parentId = null;
  let parentName = 'Top Level';
  if (selectedNode) {
    if (selectedNode.type === 'category') {
      parentId = selectedNode.id;
      parentName = getCategoryDisplayName(parentId) || getCategoryById(parentId)?.name || parentName;
    } else if (selectedNode.type === 'trigger') {
      const trigger = getTriggerById(selectedNode.id);
      parentId = trigger ? trigger.categoryId : null;
      parentName = parentId ? getCategoryDisplayName(parentId) || parentName : parentName;
    }
  }

  const name = await showCategoryPrompt({ parentName });
  if (!name || !name.trim()) {
    return;
  }

  const category = { id: createId('cat'), name: name.trim(), parentId };
  categories.push(category);
  rebuildCategoryCaches();
  expandForCategory(category.id);
  setSelectedNode('category', category.id);
}

function createTrigger(categoryId) {
  const trigger = normalizeTrigger({
    label: 'New Trigger',
    pattern: '',
    duration: DEFAULT_TRIGGER_DURATION,
    color: '#00c9ff',
    isRegex: false,
    timer: { durationSeconds: DEFAULT_TRIGGER_DURATION },
  });
  trigger.categoryId = categoryId || null;
  updateDerivedTriggerFields(trigger);
  return trigger;
}

function handleAddTrigger() {
  let categoryId = null;
  if (selectedNode) {
    if (selectedNode.type === 'category') {
      categoryId = selectedNode.id;
    } else if (selectedNode.type === 'trigger') {
      const trigger = getTriggerById(selectedNode.id);
      categoryId = trigger ? trigger.categoryId : null;
    }
  }
  const trigger = createTrigger(categoryId);
  triggers.push(trigger);
  expandForCategory(categoryId);
  setSelectedNode('trigger', trigger.id);
}

function duplicateTrigger(id) {
  const trigger = getTriggerById(id);
  if (!trigger) return;
  const clone = JSON.parse(JSON.stringify(trigger));
  clone.id = createId('trigger');
  clone.label = `${trigger.label || 'Trigger'} Copy`;
  const normalized = normalizeTrigger(clone);
  normalized.categoryId = trigger.categoryId;
  updateDerivedTriggerFields(normalized);
  triggers.push(normalized);
  expandForCategory(normalized.categoryId);
  setSelectedNode('trigger', normalized.id);
}

function deleteTrigger(id) {
  const trigger = getTriggerById(id);
  const index = triggers.findIndex((item) => item.id === id);
  if (index === -1) return;
  const shouldDelete = window.confirm(
    `Delete trigger "${trigger?.label || trigger?.pattern || 'Trigger'}"?`
  );
  if (!shouldDelete) return;
  triggers.splice(index, 1);
  if (selectedNode && selectedNode.type === 'trigger' && selectedNode.id === id) {
    selectFirstAvailableNode();
  }
  renderTriggerTree();
  renderTriggerDetail();
}

function deleteCategory(id) {
  if (categoryHasChildren(id) || categoryHasTriggers(id)) {
    window.alert('Move or delete sub-items before deleting this category.');
    return;
  }
  const index = categories.findIndex((cat) => cat.id === id);
  if (index === -1) return;
  const category = categories[index];
  const shouldDelete = window.confirm(`Delete category "${category.name}"?`);
  if (!shouldDelete) return;
  categories.splice(index, 1);
  rebuildCategoryCaches();
  if (selectedNode && selectedNode.type === 'category' && selectedNode.id === id) {
    selectFirstAvailableNode();
  }
  renderTriggerTree();
  renderTriggerDetail();
}

function addEndEarlyRow(trigger) {
  const newEntry = { id: createId('end'), text: '', useRegex: false };
  trigger.timer.endEarlyTexts.push(newEntry);
  renderTriggerDetail();
}

function removeEndEarlyRow(trigger, entryId) {
  const index = trigger.timer.endEarlyTexts.findIndex((entry) => entry.id === entryId);
  if (index === -1) return;
  trigger.timer.endEarlyTexts.splice(index, 1);
  renderTriggerDetail();
}

function updateNestedField(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return;
      }
      current = current[index];
      continue;
    }

    if (current[part] === undefined || current[part] === null) {
      current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1];
  if (Array.isArray(current)) {
    const index = Number(lastPart);
    if (Number.isInteger(index) && index >= 0 && index < current.length) {
      current[index] = value;
    }
  } else {
    current[lastPart] = value;
  }
}

function moveTriggerToCategory(triggerId, categoryId) {
  const trigger = getTriggerById(triggerId);
  if (!trigger) {
    return false;
  }

  const normalizedCategoryId =
    categoryId && getCategoryById(categoryId) ? categoryId : null;
  const currentCategoryId = trigger.categoryId || null;
  if (currentCategoryId === normalizedCategoryId) {
    return false;
  }

  trigger.categoryId = normalizedCategoryId;
  updateDerivedTriggerFields(trigger);
  expandForCategory(normalizedCategoryId);
  setSelectedNode('trigger', trigger.id);
  renderTriggerTree();
  renderTriggerDetail();
  persistSettings().catch(() => {});
  return true;
}

function handleTriggerFieldChange(event) {
  if (!selectedNode || selectedNode.type !== 'trigger') return;
  const trigger = getTriggerById(selectedNode.id);
  if (!trigger) return;

  const field = event.target.dataset.field;
  if (!field) return;
  const type = event.target.dataset.type || event.target.type;
  const value =
    type === 'checkbox' || type === 'boolean' ? event.target.checked : event.target.value;

  if (event.target.dataset.role === 'duration-field') {
    const groupSelector = `[data-duration-group="${event.target.dataset.target}"]`;
    const groupElement = triggerDetailContainer.querySelector(groupSelector);
    if (!groupElement) return;
    const hours = Number(groupElement.querySelector('[data-part="hours"]').value) || 0;
    const minutes = Number(groupElement.querySelector('[data-part="minutes"]').value) || 0;
    const seconds = Number(groupElement.querySelector('[data-part="seconds"]').value) || 0;
    const total = combineDuration({ hours, minutes, seconds });
    updateNestedField(trigger, event.target.dataset.target, total);
    if (event.target.dataset.target === 'timer.durationSeconds') {
      trigger.duration = Math.max(1, Math.round(total));
      trigger.timer.durationSeconds = trigger.duration;
    }
    renderTriggerTree();
    renderTriggerDetail();
    return;
  }

  if (field === 'categoryId') {
    updateNestedField(trigger, field, value || null);
    updateDerivedTriggerFields(trigger);
    expandForCategory(value || null);
    renderTriggerTree();
    renderTriggerDetail();
    return;
  }

  if (field === 'label') {
    updateNestedField(trigger, field, value);
    const heading = document.getElementById('trigger-editor-title');
    if (heading) {
      heading.textContent = value || trigger.pattern || 'Trigger';
    }
    if (event.type === 'change') {
      renderTriggerTree();
    }
    return;
  }

  updateNestedField(trigger, field, value);

  if (event.type === 'change') {
    updateDerivedTriggerFields(trigger);
    renderTriggerTree();
    renderTriggerDetail();
  } else {
    updateDerivedTriggerFields(trigger);
  }
}

function handleCategoryFieldChange(event) {
  if (!selectedNode || selectedNode.type !== 'category') return;
  const category = getCategoryById(selectedNode.id);
  if (!category) return;

  const field = event.target.dataset.field;
  if (!field) return;

  if (field === 'name') {
    category.name = event.target.value;
    if (event.type === 'change') {
      if (!category.name || !category.name.trim()) {
        category.name = 'Untitled Category';
        event.target.value = category.name;
      }
      renderTriggerTree();
      renderTriggerDetail();
    }
    updateAllDerivedTriggerFields();
    return;
  }

  if (field === 'parentId') {
    const newParent = event.target.value || null;
    if (newParent === category.id) {
      event.target.value = category.parentId || '';
      return;
    }
    const disallowed = new Set(getDescendantCategoryIds(category.id));
    if (newParent && disallowed.has(newParent)) {
      window.alert('Cannot move a category inside one of its descendants.');
      event.target.value = category.parentId || '';
      return;
    }
    category.parentId = newParent;
    rebuildCategoryCaches();
    updateAllDerivedTriggerFields();
    renderTriggerTree();
    renderTriggerDetail();
  }
}

async function handleDetailClick(event) {
  const tabButton = event.target.closest('[data-action="select-tab"]');
  if (tabButton) {
    const { tab } = tabButton.dataset;
    if (tab && activeTriggerTab !== tab) {
      activeTriggerTab = tab;
      renderTriggerDetail();
    }
    return;
  }

  const toggleButton = event.target.closest('[data-action="toggle-category"]');
  if (toggleButton) {
    const { categoryId } = toggleButton.dataset;
    toggleCategoryExpansion(categoryId);
    return;
  }

  if (!selectedNode) return;
  if (selectedNode.type === 'trigger') {
    const trigger = getTriggerById(selectedNode.id);
    if (!trigger) return;

    if (event.target.matches('[data-action="delete-trigger"]')) {
      deleteTrigger(trigger.id);
      return;
    }
    if (event.target.matches('[data-action="duplicate-trigger"]')) {
      duplicateTrigger(trigger.id);
      return;
    }
    if (event.target.matches('[data-action="add-end-early"]')) {
      addEndEarlyRow(trigger);
      return;
    }
    if (event.target.matches('[data-action="remove-end-early"]')) {
      const entryId = event.target.dataset.entryId;
      removeEndEarlyRow(trigger, entryId);
      return;
    }
    if (event.target.matches('[data-action="browse-sound-file"]')) {
      if (event.target.disabled) {
        return;
      }
      try {
        const selectedPath = await window.eqApi.selectSoundFile();
        if (!selectedPath) {
          return;
        }
        const targetField = event.target.dataset.field;
        if (!targetField) {
          return;
        }
        updateNestedField(trigger, targetField, selectedPath);
        updateDerivedTriggerFields(trigger);
        renderTriggerTree();
        renderTriggerDetail();
      } catch (error) {
        console.error('Failed to select sound file', error);
      }
      return;
    }
  } else if (selectedNode.type === 'category') {
    if (event.target.matches('[data-action="delete-category"]')) {
      deleteCategory(selectedNode.id);
    }
  }
}

function handleTreeClick(event) {
  const toggle = event.target.closest('[data-action="toggle-category"]');
  if (toggle) {
    toggleCategoryExpansion(toggle.dataset.categoryId);
    return;
  }

  const item = event.target.closest('[data-node-id]');
  if (!item) return;
  const nodeType = item.dataset.nodeType;
  const nodeId = item.dataset.nodeId;
  setSelectedNode(nodeType, nodeId);
}

function updateStatus({ state, message, directory } = {}) {
  const status = state || 'idle';
  watcherStatus.textContent =
    status === 'watching' && directory ? `Watching ${directory}` : status.toUpperCase();
  watcherStatus.style.backgroundColor = `${STATUS_COLORS[status] || STATUS_COLORS.idle}1A`;
  watcherStatus.style.color = STATUS_COLORS[status] || STATUS_COLORS.idle;
  if (message) {
    watcherStatus.title = message;
  } else if (watcherStatus.hasAttribute('title')) {
    watcherStatus.removeAttribute('title');
  }

  if (headerStartStopButton) {
    if (status === 'watching') {
      headerStartStopButton.dataset.state = 'stop';
      headerStartStopButton.textContent = 'Stop Watching';
    } else {
      headerStartStopButton.dataset.state = 'start';
      headerStartStopButton.textContent = 'Start Watching';
    }
  }
}

function cancelTimersAnimation() {
  if (timersRaf) {
    cancelAnimationFrame(timersRaf);
    timersRaf = null;
  }
}

function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const abs = Math.max(0, Math.round(seconds));
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (parts.length < 2 && hours > 0) {
    parts.push(`${hours}h`);
  }
  if (parts.length < 2 && minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push(`${Math.max(1, secs)}s`);
  }
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
    return 'Unknown';
  }
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) {
    return 'Unknown';
  }
  const diffSeconds = Math.round((Date.now() - parsed) / 1000);
  if (diffSeconds < 10) {
    return 'moments ago';
  }
  return `${formatDurationShort(diffSeconds)} ago`;
}

function formatRespawnRange(mob = {}) {
  if (mob.respawnDisplay) {
    return mob.respawnDisplay;
  }
  const minMinutes = Number(mob.minRespawnMinutes);
  const maxMinutes = Number(mob.maxRespawnMinutes);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)) {
    return '';
  }
  const minLabel = formatDurationShort(minMinutes * 60);
  const maxLabel = formatDurationShort(maxMinutes * 60);
  if (minLabel === maxLabel) {
    return `Respawn ${minLabel}`;
  }
  return `Respawn ${minLabel} - ${maxLabel}`;
}

function categorizeMobWindows(mobs = []) {
  const current = [];
  const upcoming = [];
  const future = [];
  const unknown = [];

  mobs.forEach((mob) => {
    if (!mob || !mob.id) {
      return;
    }
    if (!mob.lastKillAt) {
      unknown.push(mob);
      return;
    }
    if (mob.inWindow) {
      current.push(mob);
    } else if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0 && mob.secondsUntilOpen <= 86_400) {
      upcoming.push(mob);
    } else if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0) {
      future.push(mob);
    } else {
      future.push(mob);
    }
  });

  const sortBy = (key) => (a, b) => {
    const av = Number.isFinite(a[key]) ? a[key] : Number.MAX_SAFE_INTEGER;
    const bv = Number.isFinite(b[key]) ? b[key] : Number.MAX_SAFE_INTEGER;
    return av - bv;
  };

  current.sort(sortBy('secondsUntilClose'));
  upcoming.sort(sortBy('secondsUntilOpen'));
  future.sort(sortBy('secondsUntilOpen'));

  return { current, upcoming, future, unknown };
}

function buildMobWindowItem(mob, mode) {
  const respawnRange = formatRespawnRange(mob);
  const lastKillText = mob.lastKillAt ? `Last kill ${formatSince(mob.lastKillAt)}` : 'Last kill unknown';
  const zoneParts = [mob.zone, mob.expansion].filter(Boolean).join(' • ');

  let descriptor = '';
  let footerLeft = mob.windowOpensAt ? `${mode === 'current' ? 'Opened' : 'Earliest'}: ${formatAbsoluteTime(mob.windowOpensAt)}` : 'Earliest: Unknown';
  let footerRight = mob.windowClosesAt ? `${mode === 'current' ? 'Ends' : 'Latest'}: ${formatAbsoluteTime(mob.windowClosesAt)}` : '';
  let progressPct = 0;

  if (mode === 'current') {
    descriptor = `Window ends in ${formatCountdown(mob.secondsUntilClose)}`;
    progressPct = Math.max(0, Math.min(100, Math.round((Number(mob.windowProgress) || 0) * 100)));
  } else if (mode === 'upcoming') {
    descriptor = `Window opens in ${formatCountdown(mob.secondsUntilOpen)}`;
    progressPct = 0;
  } else {
    descriptor = respawnRange || '';
  }

  const metaParts = [];
  if (descriptor) metaParts.push(descriptor);
  if (respawnRange && respawnRange !== descriptor) metaParts.push(respawnRange);
  if (lastKillText) metaParts.push(lastKillText);
  if (zoneParts) metaParts.push(zoneParts);
  const meta = metaParts.filter(Boolean).join(' • ');

  const footerRightText = footerRight ? `<span>${escapeHtml(footerRight)}</span>` : '<span></span>';

  return `
    <article class="mob-window-item">
      <div class="mob-window-header">
        <span class="mob-name">${escapeHtml(mob.name || '')}</span>
        <span class="mob-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="mob-window-progress" style="--progress: ${progressPct}%;">
        <span style="width: ${progressPct}%;"></span>
      </div>
      <div class="mob-window-footer">
        <span>${escapeHtml(footerLeft)}</span>
        ${footerRightText}
      </div>
    </article>
  `;
}

function renderMobWindowList(container, mobs, emptyMessage, mode) {
  if (!container) {
    return;
  }
  if (!mobs || mobs.length === 0) {
    container.innerHTML = `<div class="mob-window-empty">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  container.innerHTML = mobs.map((mob) => buildMobWindowItem(mob, mode)).join('');
}

function renderMobWindowTable(snapshot) {
  if (!mobWindowTableContainer) {
    return;
  }
  const mobs = Array.isArray(snapshot?.mobs) ? snapshot.mobs : Array.isArray(snapshot) ? snapshot : [];
  if (mobs.length === 0) {
    mobWindowTableContainer.innerHTML = '<div class="mob-window-empty">No tracked mobs configured.</div>';
    return;
  }

  const rowsHtml = mobs
    .map((mob) => {
      const respawnRange = formatRespawnRange(mob);
      const lastKillDisplay = mob.lastKillAt
        ? `${formatAbsoluteTime(mob.lastKillAt)} (${formatSince(mob.lastKillAt)})`
        : 'Unknown';
      const statusParts = [];
      if (mob.inWindow) {
        statusParts.push('In window');
        if (Number.isFinite(mob.secondsUntilClose)) {
          statusParts.push(`ends in ${formatCountdown(mob.secondsUntilClose)}`);
        }
      } else if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0) {
        statusParts.push(`Opens in ${formatCountdown(mob.secondsUntilOpen)}`);
      } else if (!mob.lastKillAt) {
        statusParts.push('Awaiting first kill');
      } else {
        statusParts.push('Window closed');
      }
      const statusText = statusParts.join(' • ');
      const clearDisabled = mob.lastKillAt ? '' : 'disabled';
      const zoneText = [mob.zone, mob.expansion].filter(Boolean).join(' • ');
      return `
        <tr data-mob-id="${escapeHtml(mob.id || '')}">
          <td>
            <div>${escapeHtml(mob.name || '')}</div>
            ${zoneText ? `<div class="mob-window-zone">${escapeHtml(zoneText)}</div>` : ''}
          </td>
          <td>${escapeHtml(lastKillDisplay)}</td>
          <td>${escapeHtml(respawnRange)}</td>
          <td>${escapeHtml(statusText)}</td>
          <td>
            <div class="mob-window-actions">
              <button type="button" data-action="set-now" data-mob-id="${escapeHtml(mob.id || '')}">Mark Kill Now</button>
              <button type="button" class="danger" data-action="clear" data-mob-id="${escapeHtml(mob.id || '')}" ${clearDisabled}>Clear</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  mobWindowTableContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Mob</th>
          <th>Last Kill</th>
          <th>Respawn</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function renderMobWindows(snapshot) {
  const mobs = Array.isArray(snapshot?.mobs) ? snapshot.mobs : [];
  const categories = categorizeMobWindows(mobs);
  renderMobWindowList(
    mobWindowCurrentContainer,
    categories.current,
    'No mobs are currently in window.',
    'current'
  );
  renderMobWindowList(
    mobWindowUpcomingContainer,
    categories.upcoming,
    'No windows expected in the next 24 hours.',
    'upcoming'
  );
  renderMobWindowTable(snapshot);
}

async function handleMobWindowActionClick(event) {
  const button = event.target.closest('button[data-mob-id]');
  if (!button || button.disabled) {
    return;
  }
  const mobId = button.dataset.mobId;
  const action = button.dataset.action;
  if (!mobId || !action) {
    return;
  }
  try {
    if (action === 'set-now') {
      const snapshot = await window.eqApi.recordMobKill(mobId, new Date().toISOString());
      if (snapshot && snapshot.mobs) {
        mobWindowSnapshot = snapshot;
        renderMobWindows(mobWindowSnapshot);
      }
    } else if (action === 'clear') {
      const snapshot = await window.eqApi.clearMobKill(mobId);
      if (snapshot && snapshot.mobs) {
        mobWindowSnapshot = snapshot;
        renderMobWindows(mobWindowSnapshot);
      }
    }
  } catch (error) {
    console.error('Failed to update mob window state', error);
  }
}

function renderTimers(timers) {
  if (!timers || timers.length === 0) {
    cancelTimersAnimation();
    activeTimersContainer.innerHTML = '<p class="empty-state">No active timers.</p>';
    return;
  }

  const now = Date.now();
  activeTimersContainer.innerHTML = timers
    .map((timer) => {
      const remaining = Math.max(
        0,
        timer.expiresAt ? Date.parse(timer.expiresAt) - now : timer.remainingMs || 0
      );
      const total = Math.max(timer.duration * 1000, 1);
      const progress = Math.max(0, Math.min(1, 1 - remaining / total));
      const scaledProgress = progress <= 0 ? 0 : Math.max(0.02, progress);
      const remainingSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      return `
        <div class="timer-pill" style="--accent: ${timer.color || '#00c9ff'}">
          <div class="timer-progress-track">
            <div class="timer-progress-fill" style="transform: scaleX(${scaledProgress.toFixed(4)})"></div>
          </div>
          <div class="timer-content">
            <span>${escapeHtml(timer.label || '')}</span>
            <span class="remaining">${minutes}:${seconds.toString().padStart(2, '0')}</span>
          </div>
        </div>
      `;
    })
    .join('');

  timersRaf = requestAnimationFrame(() => renderTimers(timers));
}

function renderRecentLines() {
  if (recentLines.length === 0) {
    recentLinesList.innerHTML = '<li class="empty-state">Awaiting log data…</li>';
    return;
  }

  recentLinesList.innerHTML = recentLines
    .map(
      (entry) => `
        <li>
          <strong>${escapeHtml(new Date(entry.timestamp).toLocaleTimeString())}</strong>
          &nbsp;
          ${escapeHtml(entry.line)}
        </li>`
    )
    .join('');
}

function serializeCategories() {
  return categories.map((category) => ({ ...category }));
}

function serializeTriggers() {
  return triggers.map((trigger) => ({
    ...trigger,
    textSettings: { ...trigger.textSettings },
    audio: { ...trigger.audio },
    timer: {
      ...trigger.timer,
      endEarlyTexts: trigger.timer.endEarlyTexts.map((entry) => ({ ...entry })),
    },
    timerEnding: {
      ...trigger.timerEnding,
      textSettings: { ...trigger.timerEnding.textSettings },
      audio: { ...trigger.timerEnding.audio },
    },
    timerEnded: {
      ...trigger.timerEnded,
      textSettings: { ...trigger.timerEnded.textSettings },
      audio: { ...trigger.timerEnded.audio },
    },
    counter: { ...trigger.counter },
    categoryId: trigger.categoryId || null,
    categoryPath: getCategoryPath(trigger.categoryId),
    category: getCategoryDisplayName(trigger.categoryId),
  }));
}

async function persistSettings() {
  const payload = {
    logDirectory: logDirectoryInput.value.trim(),
    backendUrl: backendUrlInput.value.trim(),
    overlayOpacity: Number(overlayOpacityInput.value),
    overlayClickThrough: overlayClickThroughInput.checked,
    categories: serializeCategories(),
    triggers: serializeTriggers(),
  };

  updateDirectorySummary(payload.logDirectory);
  await window.eqApi.updateSettings(payload);
}

async function hydrate() {
  await window.eqApi.ready();
  const stored = await window.eqApi.loadSettings();
  logDirectoryInput.value = stored.logDirectory || '';
  backendUrlInput.value = stored.backendUrl || '';
  overlayOpacityInput.value = stored.overlayOpacity || 0.85;
  overlayClickThroughInput.checked = Boolean(stored.overlayClickThrough);
  overlayOpacityValue.textContent = Number(overlayOpacityInput.value).toFixed(2);
  updateDirectorySummary(logDirectoryInput.value);

  categories = normalizeCategories(stored.categories || []);
  rebuildCategoryCaches();
  triggers = normalizeTriggers(Array.isArray(stored.triggers) ? stored.triggers : []);
  updateAllDerivedTriggerFields();

  expandedCategories = new Set([ROOT_CATEGORY_ID, ...categories.filter((cat) => !cat.parentId).map((cat) => cat.id)]);
  selectFirstAvailableNode();
  renderTriggerTree();
  renderTriggerDetail();

  if (window.eqApi.getMobWindows) {
    try {
      const snapshot = await window.eqApi.getMobWindows();
      mobWindowSnapshot = snapshot || { generatedAt: null, mobs: [] };
    } catch (error) {
      mobWindowSnapshot = { generatedAt: null, mobs: [] };
    }
    renderMobWindows(mobWindowSnapshot);
  } else {
    renderMobWindows(mobWindowSnapshot);
  }

  try {
    overlayMoveMode = Boolean(await window.eqApi.getOverlayMoveMode());
  } catch (error) {
    overlayMoveMode = false;
  }
  updateMoveModeButton();
}

function attachEventListeners() {
  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      switchView(button.dataset.viewTarget || 'dashboard');
    });
  });

  if (headerStartStopButton) {
    headerStartStopButton.dataset.state = 'start';
    headerStartStopButton.textContent = 'Start Watching';
    headerStartStopButton.addEventListener('click', async () => {
      try {
        const isStart = headerStartStopButton.dataset.state !== 'stop';
        if (isStart) {
          await persistSettings();
          await window.eqApi.startWatcher();
        } else {
          await window.eqApi.stopWatcher();
        }
      } catch (error) {
        console.error('Failed to toggle watcher from header', error);
      }
    });
  }

  chooseLogDirButton.addEventListener('click', async () => {
    const directory = await window.eqApi.selectLogDirectory();
    if (directory) {
      logDirectoryInput.value = directory;
      updateDirectorySummary(directory);
      await persistSettings();
    }
  });

  document.getElementById('save-triggers').addEventListener('click', async () => {
    await persistSettings();
  });

  document.getElementById('add-trigger').addEventListener('click', () => {
    handleAddTrigger();
  });

  document.getElementById('add-category').addEventListener('click', () => {
    handleAddCategory();
  });

  document.getElementById('reset-triggers').addEventListener('click', async () => {
    const defaults = await window.eqApi.loadDefaultTriggers();
    categories = [];
    triggers = normalizeTriggers(Array.isArray(defaults) ? defaults : []);
    updateAllDerivedTriggerFields();
    expandedCategories = new Set([ROOT_CATEGORY_ID, ...categories.filter((cat) => !cat.parentId).map((cat) => cat.id)]);
    selectFirstAvailableNode();
    renderTriggerTree();
    renderTriggerDetail();
    await persistSettings();
  });

  const importBtn = document.getElementById('import-gtp');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      try {
        const imported = await window.eqApi.importGinaGtp();
        if (Array.isArray(imported) && imported.length > 0) {
          categories = [];
          triggers = normalizeTriggers(imported);
          updateAllDerivedTriggerFields();
          expandedCategories = new Set([ROOT_CATEGORY_ID, ...categories.filter((cat) => !cat.parentId).map((cat) => cat.id)]);
          selectFirstAvailableNode();
          renderTriggerTree();
          renderTriggerDetail();
          await persistSettings();
        }
      } catch (err) {
        console.error('Import failed', err);
        alert('Failed to import GINA .gtp. Check console for details.');
      }
    });
  }

  const exportBtn = document.getElementById('export-triggers');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const serialized = serializeTriggers();
        await window.eqApi.exportTriggers(serialized);
      } catch (err) {
        console.error('Export failed', err);
        alert('Failed to export triggers. Check console for details.');
      }
    });
  }

  backendUrlInput.addEventListener('blur', persistSettings);

  overlayOpacityInput.addEventListener('input', async (event) => {
    const value = Number(event.target.value) || 0.85;
    overlayOpacityValue.textContent = value.toFixed(2);
    await window.eqApi.setOverlayOpacity(value);
    await persistSettings();
  });

  overlayClickThroughInput.addEventListener('change', async (event) => {
    await window.eqApi.setOverlayClickThrough(event.target.checked);
    await persistSettings();
  });

  document.getElementById('show-overlay').addEventListener('click', () => {
    window.eqApi.showOverlay();
  });

  if (showMobOverlayButton) {
    showMobOverlayButton.addEventListener('click', () => {
      window.eqApi.showMobOverlay();
    });
  }

  toggleMoveModeButton.addEventListener('click', async () => {
    try {
      overlayMoveMode = !(overlayMoveMode === true);
      const actual = await window.eqApi.setOverlayMoveMode(overlayMoveMode);
      overlayMoveMode = Boolean(actual);
      updateMoveModeButton();
    } catch (err) {
      console.error('Failed to toggle overlay move mode', err);
    }
  });

  if (mobWindowTableContainer) {
    mobWindowTableContainer.addEventListener('click', handleMobWindowActionClick);
  }

  triggerTreeContainer.addEventListener('dragstart', (event) => {
    const item = event.target.closest('[data-drag-type="trigger"]');
    if (!item) return;
    draggedTriggerId = item.dataset.nodeId;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', draggedTriggerId);
      } catch (err) {
        // Ignore browsers that prevent setting data
      }
    }
    item.classList.add('dragging');
  });

  triggerTreeContainer.addEventListener('dragend', () => {
    const dragging = triggerTreeContainer.querySelector('.tree-item.trigger.dragging');
    if (dragging) {
      dragging.classList.remove('dragging');
    }
    draggedTriggerId = null;
    clearCurrentDropTarget();
  });

  triggerTreeContainer.addEventListener('dragover', (event) => {
    if (!draggedTriggerId) return;
    const dropTarget = getDropTargetElement(event.target);
    if (!dropTarget) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (currentDropTarget !== dropTarget) {
      clearCurrentDropTarget();
      dropTarget.classList.add('drag-over');
      currentDropTarget = dropTarget;
    }
  });

  triggerTreeContainer.addEventListener('dragleave', (event) => {
    if (!draggedTriggerId) return;
    const dropTarget = getDropTargetElement(event.target);
    if (!dropTarget) return;
    if (event.relatedTarget && dropTarget.contains(event.relatedTarget)) {
      return;
    }
    if (currentDropTarget === dropTarget) {
      dropTarget.classList.remove('drag-over');
      currentDropTarget = null;
    }
  });

  triggerTreeContainer.addEventListener('drop', (event) => {
    if (!draggedTriggerId) return;
    const dropTarget = getDropTargetElement(event.target);
    if (!dropTarget) return;
    event.preventDefault();
    const targetType = dropTarget.dataset.dropTarget;
    const categoryId =
      targetType === 'category' ? dropTarget.dataset.categoryId || null : null;
    moveTriggerToCategory(draggedTriggerId, categoryId);
    draggedTriggerId = null;
    clearCurrentDropTarget();
  });

  triggerTreeContainer.addEventListener('click', handleTreeClick);
  triggerDetailContainer.addEventListener('click', handleDetailClick);
  triggerDetailContainer.addEventListener('input', (event) => {
    if (event.target.dataset.role === 'trigger-field') {
      handleTriggerFieldChange(event);
    } else if (event.target.dataset.role === 'category-field') {
      handleCategoryFieldChange(event);
    }
  });
  triggerDetailContainer.addEventListener('change', (event) => {
    if (event.target.dataset.role === 'trigger-field') {
      handleTriggerFieldChange(event);
    } else if (event.target.dataset.role === 'category-field') {
      handleCategoryFieldChange(event);
    }
  });
}

function subscribeToIpc() {
  window.eqApi.onTimersUpdate((timers) => {
    renderTimers(timers);
  });

  if (window.eqApi.onMobWindowsUpdate) {
    window.eqApi.onMobWindowsUpdate((snapshot) => {
      mobWindowSnapshot = snapshot || { generatedAt: null, mobs: [] };
      renderMobWindows(mobWindowSnapshot);
    });
  }

  window.eqApi.onWatcherStatus((status) => {
    updateStatus(status);
  });

  window.eqApi.onWatcherLines((lines) => {
    recentLines = [...lines, ...recentLines].slice(0, 30);
    renderRecentLines();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await hydrate();
  attachEventListeners();
  switchView('dashboard');
  subscribeToIpc();
  renderTimers([]);
  renderMobWindows(mobWindowSnapshot);
  renderRecentLines();
  updateStatus({ state: 'idle' });
});

function updateMoveModeButton() {
  if (!toggleMoveModeButton) return;
  toggleMoveModeButton.textContent = overlayMoveMode ? 'Done Moving' : 'Move Overlays';
  toggleMoveModeButton.classList.toggle('active', overlayMoveMode);
}



