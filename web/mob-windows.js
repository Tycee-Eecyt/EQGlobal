const currentList = document.getElementById('current-list');
const upcomingList = document.getElementById('upcoming-list');
const futureList = document.getElementById('future-list');
const tableBody = document.querySelector('#mob-table tbody');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshButton = document.getElementById('refresh-button');

const REFRESH_INTERVAL = 30000;
const UPCOMING_WINDOW_SECONDS = 24 * 60 * 60;
const FUTURE_WINDOW_SECONDS = 72 * 60 * 60;

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
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `${parts.join(' ')} ${seconds >= 0 ? 'ago' : 'from now'}`;
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
      ? `closes in ${formatSince(-mob.secondsUntilClose)}`
      : 'currently active';
    return { text: `In window - ${remaining}`, className: 'danger' };
  }
  if (Number.isFinite(mob.secondsUntilOpen) && mob.secondsUntilOpen > 0) {
    return { text: `Opens in ${formatSince(-mob.secondsUntilOpen)}`, className: 'neutral' };
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
  try {
    const response = await fetch('/api/mob-windows', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }
    const data = await response.json();
    const snapshot = data?.snapshot && Array.isArray(data.snapshot.mobs)
      ? data.snapshot
      : { generatedAt: data?.updatedAt || null, mobs: Array.isArray(data?.mobs) ? data.mobs : [] };
    renderLists(snapshot);
  } catch (error) {
    console.error('Failed to load mob windows', error);
    const message = 'Failed to load mob windows. Please try again.';
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
      lastUpdatedEl.textContent = 'Last updated: error';
    }
  }
}

refreshButton?.addEventListener('click', () => {
  fetchAndRender();
});

fetchAndRender();
setInterval(fetchAndRender, REFRESH_INTERVAL);
