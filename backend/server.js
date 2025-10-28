const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');
const { sanitizeRegexPattern } = require('../src/shared/regex');

const mobWindowDefinitions = require('../src/shared/mobWindows.json');
const MobWindowManager = require('../src/main/mobWindowManager');
const passport = require('passport');
const configurePassport = require('./auth/passport');
const createAuthMiddleware = require('./auth/middleware');
const createAuthRouter = require('./auth/routes');
const { ROLE_LEVELS } = require('./auth/roles');

require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, '..', 'web')));

const port = process.env.PORT || 4000;
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || 'eqglobal';
// Feature flag: disable persisting log events by default
const persistLogEvents = /^true$/i.test(process.env.PERSIST_LOG_EVENTS || '');

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

configurePassport({ passport, getDb: ensureMongoConnection });
const authMiddleware = createAuthMiddleware({ passport });
const { authenticateJwt, requireRoleAtMost } = authMiddleware;
app.use(
  '/api/auth',
  createAuthRouter({
    passport,
    getDb: ensureMongoConnection,
    middleware: authMiddleware,
  })
);

const mobAliasIndex = new Map();
const mobDefinitionsById = new Map();
let aliasOverridesByMobId = new Map();

// --- Global Log Forwarding Triggers (Admin-configured) ---
let logForwardConfig = {
  triggers: [], // persisted raw triggers
  compiled: [], // compiled matcher functions
  updatedAt: null,
};

function compileLogTriggers(triggers = []) {
  const out = [];
  (Array.isArray(triggers) ? triggers : []).forEach((t) => {
    if (t && t.enabled === false) return;
    const isRegex = Boolean(t.isRegex);
    const flags = (t.flags || 'i').replace(/[^gimsuy]/gi, '');
    const pattern = String(t.pattern || '').trim();
    if (!pattern) return;

    let matcher = null;
    if (isRegex) {
      try {
        const sanitized = sanitizeRegexPattern(pattern);
        const re = new RegExp(sanitized, flags || 'i');
        matcher = (line) => re.test(String(line || ''));
      } catch (_err) {
        // fall back to substring match if bad regex
        const needle = pattern.toLowerCase();
        matcher = (line) => String(line || '').toLowerCase().includes(needle);
      }
    } else {
      const needle = pattern.toLowerCase();
      matcher = (line) => String(line || '').toLowerCase().includes(needle);
    }

    out.push({ id: t.id || pattern, matcher });
  });
  return out;
}

async function loadLogForwardConfig(db) {
  try {
    const collection = db.collection('log_forward_config');
    const doc = await collection.findOne({ _id: 'global' });
    const triggers = Array.isArray(doc?.triggers) ? doc.triggers : [];
    logForwardConfig.triggers = triggers;
    logForwardConfig.compiled = compileLogTriggers(triggers);
    logForwardConfig.updatedAt = doc?.updatedAt ? new Date(doc.updatedAt) : null;
  } catch (err) {
    console.warn('Failed to load log forward config:', err.message);
    logForwardConfig.triggers = [];
    logForwardConfig.compiled = [];
    logForwardConfig.updatedAt = null;
  }
}

async function persistLogForwardConfig(db) {
  const collection = db.collection('log_forward_config');
  const payload = {
    triggers: Array.isArray(logForwardConfig.triggers) ? logForwardConfig.triggers : [],
    updatedAt: new Date(),
  };
  await collection.updateOne(
    { _id: 'global' },
    { $set: payload },
    { upsert: true }
  );
  // refresh compiled
  logForwardConfig.compiled = compileLogTriggers(payload.triggers);
  logForwardConfig.updatedAt = payload.updatedAt;
}

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

function rebuildAliasIndex() {
  if (!Array.isArray(mobWindowDefinitions)) {
    return;
  }
  mobAliasIndex.clear();
  mobDefinitionsById.clear();
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

  // Apply alias overrides from DB
  if (aliasOverridesByMobId && aliasOverridesByMobId.size > 0) {
    aliasOverridesByMobId.forEach((aliases, mobId) => {
      if (!aliases || !Array.isArray(aliases)) return;
      aliases.forEach((alias) => {
        normalizeAliasKey(alias).forEach((key) => {
          if (!mobAliasIndex.has(key)) {
            mobAliasIndex.set(key, mobId);
          }
        });
      });
    });
  }
}

rebuildAliasIndex();

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

async function loadAliasOverrides(db) {
  try {
    const collection = db.collection('mob_alias_overrides');
    const doc = await collection.findOne({ _id: 'global' });
    aliasOverridesByMobId = new Map();
    if (doc && doc.aliases && typeof doc.aliases === 'object') {
      for (const [mobId, arr] of Object.entries(doc.aliases)) {
        aliasOverridesByMobId.set(mobId, Array.isArray(arr) ? arr.filter(Boolean) : []);
      }
    }
    rebuildAliasIndex();
  } catch (err) {
    console.warn('Failed to load alias overrides:', err.message);
  }
}

async function persistAliasOverrides(db) {
  const obj = {};
  aliasOverridesByMobId.forEach((arr, mobId) => {
    obj[mobId] = Array.isArray(arr) ? arr.filter(Boolean) : [];
  });
  const collection = db.collection('mob_alias_overrides');
  await collection.updateOne({ _id: 'global' }, { $set: { aliases: obj, updatedAt: new Date() } }, { upsert: true });
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
    await loadAliasOverrides(mongoDb);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

app.post(
  '/api/log-lines',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'Expected "lines" to be an array.' });
  }

  try {
    const db = await ensureMongoConnection();
    // Ensure trigger config is loaded
    if (!logForwardConfig || !Array.isArray(logForwardConfig.triggers)) {
      await loadLogForwardConfig(db);
    }
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

    // Filter which documents to persist based on admin-configured triggers
    let toInsert = [];
    const compiled = Array.isArray(logForwardConfig.compiled) ? logForwardConfig.compiled : [];
    if (documents.length > 0 && compiled.length > 0) {
      toInsert = documents.filter((doc) => compiled.some((c) => c.matcher(doc.line)));
    }

    if (toInsert.length === 0) {
      if (mobUpdates.size > 0) {
        await applyMobKillUpdates(db, mobUpdates);
      }
      return res.json({ inserted: 0 });
    }

    const result = await collection.insertMany(toInsert, { ordered: false });

    if (mobUpdates.size > 0) {
      await applyMobKillUpdates(db, mobUpdates);
    }

    res.json({ inserted: result.insertedCount || toInsert.length });
  } catch (error) {
    console.error('Failed to persist log lines', error);
    res.status(500).json({ error: 'Failed to persist log lines.' });
  }
  }
);

// Return last N ToD records for a mob, inferred from ingested log lines
app.get(
  '/api/tod-history/:mobId',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
  const mobId = String(req.params.mobId || '').trim();
  if (!mobId || !mobDefinitionsById.has(mobId)) {
    return res.status(400).json({ error: 'Unknown mobId.' });
  }
  try {
    const db = await ensureMongoConnection();
    const collection = db.collection('log_lines');
    const cursor = collection.find({ line: { $regex: /^!?tod\s+/i } }).sort({ timestamp: -1 }).limit(2000);
    const history = [];
    for await (const doc of cursor) {
      const parsed = extractTodCommandFromLineV2(doc.line);
      if (!parsed || parsed.kind !== 'mob') continue;
      const mob = findMobByAlias(parsed.target);
      if (!mob || mob.id !== mobId) continue;
      const ts = doc.timestamp instanceof Date ? doc.timestamp : new Date(doc.timestamp);
      history.push({
        mobId,
        line: doc.line,
        timestamp: ts.toISOString(),
        filePath: doc.filePath || null,
      });
      if (history.length >= 10) break;
    }
    res.json({ mobId, entries: history });
  } catch (err) {
    console.error('Failed to fetch ToD history', err);
    res.status(500).json({ error: 'Failed to fetch ToD history.' });
  }
  }
);

app.post(
  '/api/log-events',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'Expected "events" to be an array.' });
  }

  // By default, do not persist log events. Opt-in via PERSIST_LOG_EVENTS=true
  if (!persistLogEvents) {
    return res.json({ inserted: 0, persisted: false });
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
      return res.json({ inserted: 0, persisted: true });
    }

    const result = await collection.insertMany(documents, { ordered: false });
    res.json({ inserted: result.insertedCount || documents.length, persisted: true });
  } catch (error) {
    console.error('Failed to persist log events', error);
    res.status(500).json({ error: 'Failed to persist log events.' });
  }
  }
);

app.get(
  '/api/mob-windows',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (_req, res) => {
    try {
      const db = await ensureMongoConnection();
      await loadAliasOverrides(db);
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
  }
);

app.post(
  '/api/mob-windows',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
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
  }
);
app.post(
  '/api/mob-windows/clear',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
    const { mobId, mob } = req.body || {};
    let targetMobId = null;
    if (mobId && mobDefinitionsById.has(mobId)) {
      targetMobId = mobId;
    } else if (mob) {
      const hit = findMobByAlias(mob);
      if (hit) targetMobId = hit.id;
    }
    if (!targetMobId) {
      return res.status(400).json({ error: 'Unknown mob. Provide mobId or recognizable name.' });
    }
    try {
      const db = await ensureMongoConnection();
      const collection = db.collection('mob_windows');
      const doc = await collection.findOne({ _id: 'global' });
      const kills = doc && doc.kills ? { ...doc.kills } : {};
      if (Object.prototype.hasOwnProperty.call(kills, targetMobId)) {
        delete kills[targetMobId];
      }
      const updatedAt = new Date();
      await collection.updateOne({ _id: 'global' }, { $set: { kills, updatedAt } }, { upsert: true });
      const snapshot = buildSnapshotFromKills(kills);
      res.json({ kills, updatedAt: updatedAt.toISOString(), mobs: snapshot.mobs, snapshot });
    } catch (err) {
      console.error('Failed to clear mob kill', err);
      res.status(500).json({ error: 'Failed to clear mob kill.' });
    }
  }
);

// Add an alias mapping to an existing mob
app.post(
  '/api/mobs/alias',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  async (req, res) => {
    const { mob, mobId, alias } = req.body || {};
    const aliasText = String(alias || '').trim();
    if (!aliasText) return res.status(400).json({ error: 'Alias is required.' });
    let targetMobId = null;
    if (mobId && mobDefinitionsById.has(mobId)) {
      targetMobId = mobId;
    } else if (mob) {
      const hit = findMobByAlias(mob);
      if (hit) targetMobId = hit.id;
      else if (mobDefinitionsById.has(String(mob))) targetMobId = String(mob);
    }
    if (!targetMobId) return res.status(400).json({ error: 'Unknown mob. Provide mobId or recognizable name.' });
    try {
      const db = await ensureMongoConnection();
      await loadAliasOverrides(db);
      const list = aliasOverridesByMobId.get(targetMobId) || [];
      if (!list.includes(aliasText)) list.push(aliasText);
      aliasOverridesByMobId.set(targetMobId, list);
      await persistAliasOverrides(db);
      rebuildAliasIndex();
      res.json({ ok: true, mobId: targetMobId, alias: aliasText });
    } catch (err) {
      console.error('Failed to add alias', err);
      res.status(500).json({ error: 'Failed to add alias.' });
    }
  }
);

// Remove an alias mapping previously added
app.delete(
  '/api/mobs/alias',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.OFFICER),
  async (req, res) => {
    const { mob, mobId, alias } = req.body || {};
    const aliasText = String(alias || '').trim();
    if (!aliasText) return res.status(400).json({ error: 'Alias is required.' });
    let targetMobId = null;
    if (mobId && mobDefinitionsById.has(mobId)) {
      targetMobId = mobId;
    } else if (mob) {
      const hit = findMobByAlias(mob);
      if (hit) targetMobId = hit.id;
      else if (mobDefinitionsById.has(String(mob))) targetMobId = String(mob);
    }
    if (!targetMobId) return res.status(400).json({ error: 'Unknown mob. Provide mobId or recognizable name.' });
    try {
      const db = await ensureMongoConnection();
      await loadAliasOverrides(db);
      const list = aliasOverridesByMobId.get(targetMobId) || [];
      const filtered = list.filter((a) => a.toLowerCase() !== aliasText.toLowerCase());
      aliasOverridesByMobId.set(targetMobId, filtered);
      await persistAliasOverrides(db);
      rebuildAliasIndex();
      res.json({ ok: true, mobId: targetMobId, alias: aliasText });
    } catch (err) {
      console.error('Failed to remove alias', err);
      res.status(500).json({ error: 'Failed to remove alias.' });
    }
  }
);

// List all known mobs (id, name, zone)
app.get(
  '/api/mobs',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  (_req, res) => {
  const defs = [];
  mobDefinitionsById.forEach((def) => {
    defs.push({ id: def.id, name: def.name, zone: def.zone || '' });
  });
  defs.sort((a, b) => a.name.localeCompare(b.name));
  res.json(defs);
  }
);

// Resolve free-text to a mob by alias
app.get(
  '/api/mobs/resolve',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.TRACKER),
  (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const hit = findMobByAlias(text);
  if (!hit) return res.status(404).json({ error: 'No match' });
  res.json({ id: hit.id, name: hit.definition?.name || hit.id });
  }
);

app.listen(port, async () => {
  console.log(`EQGlobal backend listening on http://localhost:${port}`);
  if (!mongoUri) {
    console.warn('MONGODB_URI is not set. Log data will not be persisted until configured.');
  } else {
    try {
      await ensureMongoConnection();
      await loadAliasOverrides(mongoDb);
      await loadLogForwardConfig(mongoDb);
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

// --- Admin API: Log trigger CRUD and testing ---
app.get(
  '/api/log-triggers',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.ADMIN),
  async (_req, res) => {
    try {
      const db = await ensureMongoConnection();
      await loadLogForwardConfig(db);
      res.json({
        updatedAt: logForwardConfig.updatedAt ? logForwardConfig.updatedAt.toISOString() : null,
        triggers: logForwardConfig.triggers || [],
      });
    } catch (err) {
      console.error('Failed to load log triggers', err);
      res.status(500).json({ error: 'Failed to load log triggers.' });
    }
  }
);

app.post(
  '/api/log-triggers',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.ADMIN),
  async (req, res) => {
    const { label, pattern, isRegex, flags, enabled, description } = req.body || {};
    const trimmedPattern = String(pattern || '').trim();
    if (!trimmedPattern) {
      return res.status(400).json({ error: 'pattern is required' });
    }
    try {
      const db = await ensureMongoConnection();
      await loadLogForwardConfig(db);
      const id = (String(label || trimmedPattern)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')) || `t-${Date.now()}`;
      const trigger = {
        id,
        label: String(label || '').trim() || id,
        pattern: trimmedPattern,
        isRegex: Boolean(isRegex),
        flags: String(flags || '').trim() || 'i',
        enabled: enabled !== false,
        description: String(description || '').trim() || undefined,
      };
      const existing = Array.isArray(logForwardConfig.triggers) ? logForwardConfig.triggers : [];
      const idx = existing.findIndex((t) => String(t.id) === id);
      if (idx >= 0) {
        existing[idx] = trigger;
      } else {
        existing.push(trigger);
      }
      logForwardConfig.triggers = existing;
      await persistLogForwardConfig(db);
      res.json({ ok: true, trigger, updatedAt: logForwardConfig.updatedAt.toISOString() });
    } catch (err) {
      console.error('Failed to create/update trigger', err);
      res.status(500).json({ error: 'Failed to create/update trigger.' });
    }
  }
);

app.put(
  '/api/log-triggers/:id',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.ADMIN),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    const { label, pattern, isRegex, flags, enabled, description } = req.body || {};
    const trimmedPattern = pattern !== undefined ? String(pattern).trim() : undefined;
    try {
      const db = await ensureMongoConnection();
      await loadLogForwardConfig(db);
      const list = Array.isArray(logForwardConfig.triggers) ? logForwardConfig.triggers : [];
      const idx = list.findIndex((t) => String(t.id) === id);
      if (idx < 0) return res.status(404).json({ error: 'not found' });
      const prev = list[idx];
      const next = {
        ...prev,
        ...(label !== undefined ? { label: String(label || '').trim() } : {}),
        ...(trimmedPattern !== undefined ? { pattern: trimmedPattern } : {}),
        ...(isRegex !== undefined ? { isRegex: Boolean(isRegex) } : {}),
        ...(flags !== undefined ? { flags: String(flags || '').trim() } : {}),
        ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
        ...(description !== undefined ? { description: String(description || '').trim() || undefined } : {}),
      };
      list[idx] = next;
      logForwardConfig.triggers = list;
      await persistLogForwardConfig(db);
      res.json({ ok: true, trigger: next, updatedAt: logForwardConfig.updatedAt.toISOString() });
    } catch (err) {
      console.error('Failed to update trigger', err);
      res.status(500).json({ error: 'Failed to update trigger.' });
    }
  }
);

app.delete(
  '/api/log-triggers/:id',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.ADMIN),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const db = await ensureMongoConnection();
      await loadLogForwardConfig(db);
      const list = Array.isArray(logForwardConfig.triggers) ? logForwardConfig.triggers : [];
      const next = list.filter((t) => String(t.id) !== id);
      logForwardConfig.triggers = next;
      await persistLogForwardConfig(db);
      res.json({ ok: true, updatedAt: logForwardConfig.updatedAt.toISOString() });
    } catch (err) {
      console.error('Failed to delete trigger', err);
      res.status(500).json({ error: 'Failed to delete trigger.' });
    }
  }
);

app.post(
  '/api/log-triggers:test',
  authenticateJwt,
  requireRoleAtMost(ROLE_LEVELS.ADMIN),
  async (req, res) => {
    const { line } = req.body || {};
    const text = String(line || '').trim();
    try {
      const db = await ensureMongoConnection();
      await loadLogForwardConfig(db);
      const compiled = Array.isArray(logForwardConfig.compiled) ? logForwardConfig.compiled : [];
      const hits = compiled.filter((c) => c.matcher(text)).map((c) => c.id);
      res.json({ text, matched: hits });
    } catch (err) {
      console.error('Failed to test trigger', err);
      res.status(500).json({ error: 'Failed to test trigger.' });
    }
  }
);

