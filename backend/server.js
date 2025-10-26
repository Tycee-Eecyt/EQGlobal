const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');

const mobWindowDefinitions = require('../src/shared/mobWindows.json');
const MobWindowManager = require('../src/main/mobWindowManager');

require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

const port = process.env.PORT || 4000;
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || 'eqglobal';

let mongoClient;
let mongoDb;

async function ensureMongoConnection() {
  if (mongoDb && mongoClient) {
    return mongoDb;
  }

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not configured. Check your .env file.');
  }

  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(mongoDbName);
  console.log(`Connected to MongoDB Atlas database "${mongoDbName}"`);
  return mongoDb;
}

const mobAliasIndex = new Map();
const mobDefinitionsById = new Map();

function normalizeAliasKey(value) {
  if (!value) {
    return [];
  }
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const collapsedWhitespace = trimmed.replace(/\s+/g, ' ');
  const alphanumeric = collapsedWhitespace.replace(/[^a-z0-9]+/g, '');
  const hyphenated = collapsedWhitespace.replace(/[^a-z0-9]+/g, '-');
  return Array.from(
    new Set([collapsedWhitespace, alphanumeric, hyphenated, collapsedWhitespace.replace(/[^a-z0-9]+/g, ' ')])
  ).filter(Boolean);
}

function primeMobAliasIndex() {
  if (!Array.isArray(mobWindowDefinitions)) {
    return;
  }
  mobWindowDefinitions.forEach((definition) => {
    if (!definition || !definition.id) {
      return;
    }
    mobDefinitionsById.set(definition.id, definition);
    const aliases = new Set([definition.name, ...(Array.isArray(definition.aliases) ? definition.aliases : [])]);
    aliases.forEach((alias) => {
      normalizeAliasKey(alias).forEach((key) => {
        if (!mobAliasIndex.has(key)) {
          mobAliasIndex.set(key, definition.id);
        }
      });
    });
  });
}

primeMobAliasIndex();

function buildSnapshotFromKills(kills = {}) {
  const manager = new MobWindowManager(mobWindowDefinitions, { tickRateMs: 60_000 });
  manager.loadState({ kills });
  return manager.computeSnapshot();
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'mob-windows.html'));
});

function findMobByAlias(text) {
  if (!text) {
    return null;
  }
  const candidates = normalizeAliasKey(text);
  for (const key of candidates) {
    if (mobAliasIndex.has(key)) {
      const mobId = mobAliasIndex.get(key);
      return {
        id: mobId,
        definition: mobDefinitionsById.get(mobId),
      };
    }
  }
  return null;
}

// --- Time parsing helpers for !tod commands ---
function applyTimeToDate(baseDate, hours, minutes, seconds, ampm) {
  if (!baseDate || !Number.isFinite(hours)) return null;
  const result = new Date(baseDate.getTime());
  let h = Number(hours);
  if (ampm) {
    const marker = String(ampm).toLowerCase();
    h = h % 12;
    if (marker === 'pm') h += 12;
  }
  if (!ampm && h === 24) h = 0;
  result.setHours(h, Number(minutes) || 0, Number(seconds) || 0, 0);
  return result;
}

function parseTimeOnlyExpression(value, contextDate) {
  if (!value || !contextDate) return null;
  const m = String(value).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const seconds = m[3] ? Number(m[3]) : 0;
  const marker = m[4] ? m[4].toLowerCase() : null;
  return applyTimeToDate(contextDate, hours, minutes, seconds, marker);
}

function unitToMillis(unit) {
  if (!unit) return null;
  const u = String(unit).toLowerCase();
  if (u.startsWith('m')) return 60_000;
  if (u.startsWith('h')) return 3_600_000;
  if (u.startsWith('d')) return 86_400_000;
  return null;
}

function resolveTemporalExpression(rawValue, contextDate, now = new Date()) {
  const base = contextDate ? new Date(contextDate) : null;
  const fallbackBase = base || (now ? new Date(now) : null);
  if (rawValue === null || rawValue === undefined) {
    return fallbackBase ? new Date(fallbackBase) : null;
  }
  let value = String(rawValue).trim();
  if (!value) {
    return fallbackBase ? new Date(fallbackBase) : null;
  }

  const lower = value.toLowerCase();
  if (lower === 'now' || lower === 'now!' || lower === 'now.') {
    return fallbackBase ? new Date(fallbackBase) : new Date();
  }

  const dashMatch = lower.match(/^-(\d+(?:\.\d+)?)(?:\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))?$/);
  if (dashMatch) {
    const amount = Number(dashMatch[1]);
    const unitMs = unitToMillis(dashMatch[2]) || 60_000;
    if (fallbackBase) return new Date(fallbackBase.getTime() - amount * unitMs);
    return null;
  }

  const agoMatch = lower.match(/^(\d+(?:\.\d+)?)\s*(minutes?|minute|min|mins|hours?|hour|hrs|h|days?|day|d)\s+ago$/);
  if (agoMatch) {
    const amount = Number(agoMatch[1]);
    const unitMs = unitToMillis(agoMatch[2]);
    if (fallbackBase && unitMs) return new Date(fallbackBase.getTime() - amount * unitMs);
    return null;
  }

  const relativeMatch = lower.match(/^(yesterday|today|tomorrow)(?:\s+at\s+(.+))?$/);
  if (relativeMatch) {
    const keyword = relativeMatch[1];
    const timePart = relativeMatch[2];
    const reference = fallbackBase ? new Date(fallbackBase) : new Date(now);
    reference.setHours(0, 0, 0, 0);
    if (keyword === 'yesterday') reference.setDate(reference.getDate() - 1);
    else if (keyword === 'tomorrow') reference.setDate(reference.getDate() + 1);
    if (timePart) {
      const t = parseTimeOnlyExpression(timePart, reference);
      if (t) return t;
    }
    return reference;
  }

  let candidate = value
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(about|approximately|approx|ish)\b/gi, '')
    .replace(/\b(st|nd|rd|th)\b/gi, '')
    .replace(/\b(EST|EDT|CST|CDT|PST|PDT|UTC|GMT)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*/g, ' ')
    .trim();

  candidate = candidate.replace(/(\d)(am|pm)\b/gi, '$1 $2');

  const parsedNative = Date.parse(candidate);
  if (!Number.isNaN(parsedNative)) return new Date(parsedNative);

  let m = candidate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    let hour = Number(m[4]);
    const minute = m[5] ? Number(m[5]) : 0;
    const second = m[6] ? Number(m[6]) : 0;
    const marker = m[7] ? m[7].toLowerCase() : null;
    if (marker) {
      hour = hour % 12;
      if (marker === 'pm') hour += 12;
    }
    return new Date(year, month, day, hour, minute, second, 0);
  }

  m = candidate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    const year = Number(m[3]);
    let hour = Number(m[4]);
    const minute = m[5] ? Number(m[5]) : 0;
    const second = m[6] ? Number(m[6]) : 0;
    const marker = m[7] ? m[7].toLowerCase() : null;
    if (marker) {
      hour = hour % 12;
      if (marker === 'pm') hour += 12;
    }
    return new Date(year, month, day, hour, minute, second, 0);
  }

  const timeOnly = parseTimeOnlyExpression(candidate, fallbackBase || new Date());
  if (timeOnly) return timeOnly;

  return null;
}

function extractTodCommandFromLine(line) {
  if (!line || typeof line !== 'string') {
    return null;
  }
  const match = line.match(/!tod\s+([^\r\n]+)/i);
  if (!match) {
    return null;
  }
  let remainder = match[1].trim();
  if (!remainder) {
    return null;
  }
  remainder = remainder.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  let explicitTime = null;
  const nowMatch = remainder.match(/\bnow\b/i);
  if (nowMatch) {
    explicitTime = 'now';
    remainder = remainder.slice(0, nowMatch.index).trim();
  }
  remainder = remainder.replace(/[\s\-\|,;]+$/g, '').trim();
  if (!remainder) {
    return null;
  }
  return {
    target: remainder,
    explicitTime,
  };
}

// Extended parser that supports `!tod quake [time]` and `!tod <mob> [time]`
function extractTodCommandFromLineV2(line) {
  if (!line || typeof line !== 'string') return null;
  const match = line.match(/!?tod\s+([^\r\n]+)/i);
  if (!match) return null;
  let remainder = match[1].trim();
  if (!remainder) return null;
  remainder = remainder.replace(/^[\"'`]+/, '').replace(/[\"'`]+$/, '').trim();
  remainder = remainder.replace(/#.*$/, '').trim();
  remainder = remainder.replace(/[\s]+/g, ' ').trim();

  // Quake support
  const quakeMatch = remainder.match(/^quake\b/i);
  if (quakeMatch) {
    let timeText = remainder.slice(quakeMatch[0].length).trim();
    timeText = timeText.replace(/^[,|\-]+\s*/, '').trim();
    const explicitTime = /\bnow\b/i.test(timeText) ? 'now' : null;
    return { kind: 'quake', target: 'quake', timeText: timeText || null, explicitTime };
  }

  // Mob ToD with optional trailing time
  const sepIndex = remainder.search(/[|,]/);
  const initialTarget = sepIndex >= 0 ? remainder.slice(0, sepIndex).trim() : remainder;
  let timeText = sepIndex >= 0 ? remainder.slice(sepIndex + 1).trim() : remainder.slice(initialTarget.length).trim();
  timeText = timeText.replace(/^[,|\-]+\s*/, '').trim();
  const explicitTime = /\bnow\b/i.test(timeText) ? 'now' : null;
  return { kind: 'mob', target: initialTarget, timeText: timeText || null, explicitTime };
}

async function applyMobKillUpdates(db, updates) {
  if (!updates || updates.size === 0) {
    return null;
  }
  const collection = db.collection('mob_windows');
  const existing = await collection.findOne({ _id: 'global' });
  const kills = existing && existing.kills ? { ...existing.kills } : {};
  let changed = false;
  updates.forEach((isoTimestamp, mobId) => {
    if (!kills[mobId] || isoTimestamp > kills[mobId]) {
      kills[mobId] = isoTimestamp;
      changed = true;
    }
  });
  if (!changed) {
    return null;
  }
  const updatedAt = new Date();
  await collection.updateOne(
    { _id: 'global' },
    { $set: { kills, updatedAt } },
    { upsert: true }
  );
  console.log(
    '[mob-windows] Updated via ToD commands:',
    Array.from(updates.keys()).join(', '),
    'at',
    updatedAt.toISOString()
  );
  return { kills, updatedAt };
}

app.get('/health', async (_req, res) => {
  try {
    await ensureMongoConnection();
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

app.post('/api/log-lines', async (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'Expected "lines" to be an array.' });
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('log_lines');
    const documents = lines
      .map((entry) => ({
        filePath: entry.filePath || '',
        line: entry.line || '',
        timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
        ingestedAt: new Date(),
      }))
      .filter((doc) => doc.line);

    const mobUpdates = new Map();
    let quakeIso = null;
    documents.forEach((doc) => {
      const parsed = extractTodCommandFromLineV2(doc.line);
      if (!parsed) return;

      const baseTime = doc.timestamp instanceof Date ? doc.timestamp : new Date(doc.timestamp || Date.now());

      if (parsed.kind === 'quake') {
        const resolved = parsed.explicitTime === 'now'
          ? baseTime
          : parsed.timeText
          ? resolveTemporalExpression(parsed.timeText, baseTime, baseTime)
          : baseTime;
        if (resolved && !Number.isNaN(resolved.getTime())) {
          const iso = resolved.toISOString();
          if (!quakeIso || iso > quakeIso) quakeIso = iso;
        }
        return;
      }

      // Refine mob target by shrinking words from the right until a match
      let target = parsed.target || '';
      let mob = findMobByAlias(target);
      if (!mob) {
        const tokens = target.split(/\s+/);
        for (let k = tokens.length - 1; k >= 1; k--) {
          const candidate = tokens.slice(0, k).join(' ');
          const hit = findMobByAlias(candidate);
          if (hit) {
            mob = hit;
            const consumed = candidate.length;
            let rest = (parsed.target || '').slice(consumed).trim();
            if (rest.startsWith('|') || rest.startsWith(',')) rest = rest.slice(1).trim();
            parsed.timeText = rest || parsed.timeText || null;
            break;
          }
        }
      }
      if (!mob) return;

      const resolved = parsed.explicitTime === 'now'
        ? baseTime
        : parsed.timeText
        ? resolveTemporalExpression(parsed.timeText, baseTime, baseTime)
        : baseTime;
      const timestamp = resolved && !Number.isNaN(resolved.getTime()) ? resolved : baseTime;
      const iso = timestamp.toISOString();
      const prev = mobUpdates.get(mob.id);
      if (!prev || iso > prev) {
        mobUpdates.set(mob.id, iso);
      }
    });

    // If a quake command was observed, set all known mobs to that timestamp
    if (quakeIso) {
      mobDefinitionsById.forEach((_def, mobId) => {
        const prev = mobUpdates.get(mobId);
        if (!prev || quakeIso > prev) {
          mobUpdates.set(mobId, quakeIso);
        }
      });
    }

    if (documents.length === 0) {
      if (mobUpdates.size > 0) {
        await applyMobKillUpdates(db, mobUpdates);
      }
      return res.json({ inserted: 0 });
    }

    const result = await collection.insertMany(documents, { ordered: false });

    if (mobUpdates.size > 0) {
      await applyMobKillUpdates(db, mobUpdates);
    }

    res.json({ inserted: result.insertedCount || documents.length });
  } catch (error) {
    console.error('Failed to persist log lines', error);
    res.status(500).json({ error: 'Failed to persist log lines.' });
  }
});

app.post('/api/log-events', async (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'Expected "events" to be an array.' });
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('log_events');
    const documents = events
      .map((event) => ({
        triggerId: event.triggerId || null,
        label: event.label || '',
        duration: event.duration || 0,
        color: event.color || '#00c9ff',
        filePath: event.filePath || '',
        line: event.line || '',
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        timer: event.timer || null,
        ingestedAt: new Date(),
      }))
      .filter((doc) => doc.label);

    if (documents.length === 0) {
      return res.json({ inserted: 0 });
    }

    const result = await collection.insertMany(documents, { ordered: false });
    res.json({ inserted: result.insertedCount || documents.length });
  } catch (error) {
    console.error('Failed to persist log events', error);
    res.status(500).json({ error: 'Failed to persist log events.' });
  }
});

app.get('/api/mob-windows', async (_req, res) => {
  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('mob_windows');
    const doc = await collection.findOne({ _id: 'global' });
    if (!doc) {
      const snapshot = buildSnapshotFromKills({});
      return res.json({
        kills: {},
        updatedAt: null,
        mobs: snapshot.mobs,
        snapshot,
      });
    }
    const snapshot = buildSnapshotFromKills(doc.kills || {});
    res.json({
      kills: doc.kills || {},
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
      mobs: snapshot.mobs,
      snapshot,
    });
  } catch (error) {
    console.error('Failed to load mob window state', error);
    res.status(500).json({ error: 'Failed to load mob window state.' });
  }
});

app.post('/api/mob-windows', async (req, res) => {
  const { kills } = req.body || {};
  if (!kills || typeof kills !== 'object') {
    return res.status(400).json({ error: 'Expected "kills" to be an object.' });
  }

  const sanitized = {};
  for (const [mobId, timestamp] of Object.entries(kills)) {
    if (typeof mobId !== 'string' || !mobId.trim()) {
      continue;
    }
    const iso = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString();
    if (!iso || Number.isNaN(Date.parse(iso))) {
      continue;
    }
    sanitized[mobId] = new Date(iso).toISOString();
  }

  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('mob_windows');
    const updatedAt = new Date();
    await collection.updateOne(
      { _id: 'global' },
      { $set: { kills: sanitized, updatedAt } },
      { upsert: true }
    );
    const snapshot = buildSnapshotFromKills(sanitized);
    res.json({ kills: sanitized, updatedAt: updatedAt.toISOString(), mobs: snapshot.mobs, snapshot });
  } catch (error) {
    console.error('Failed to persist mob window state', error);
    res.status(500).json({ error: 'Failed to persist mob window state.' });
  }
});

app.listen(port, async () => {
  console.log(`EQGlobal backend listening on http://localhost:${port}`);
  if (!mongoUri) {
    console.warn('MONGODB_URI is not set. Log data will not be persisted until configured.');
  } else {
    try {
      await ensureMongoConnection();
    } catch (error) {
      console.error('Unable to connect to MongoDB on startup:', error.message);
    }
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    if (mongoClient) {
      await mongoClient.close();
    }
  } finally {
    process.exit(0);
  }
});
