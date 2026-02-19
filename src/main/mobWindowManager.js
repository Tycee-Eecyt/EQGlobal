const { EventEmitter } = require('events');

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toMinutes(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

function hoursToMinutes(value) {
  const minutes = toMinutes(value);
  if (minutes === null) {
    return null;
  }
  return minutes * 60;
}

function normalizeDefinition(raw) {
  if (!raw) {
    return null;
  }

  const idSource = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : raw.name;
  if (!idSource) {
    return null;
  }

  const id = idSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : idSource;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map((alias) => String(alias).trim()).filter(Boolean)
    : [];
  const killPhrases = Array.isArray(raw.killPhrases)
    ? raw.killPhrases.map((phrase) => String(phrase).trim()).filter(Boolean)
    : [];

  let minRespawnMinutes = null;
  let maxRespawnMinutes = null;
  const maxSkips = Number.isFinite(Number(raw.maxSkips))
    ? Math.max(0, Math.floor(Number(raw.maxSkips)))
    : Number.isFinite(Number(raw.skipCount))
      ? Math.max(0, Math.floor(Number(raw.skipCount)))
      : null;

  if (raw.minRespawnMinutes || raw.maxRespawnMinutes) {
    minRespawnMinutes = toMinutes(raw.minRespawnMinutes);
    maxRespawnMinutes = toMinutes(raw.maxRespawnMinutes);
  } else if (raw.minRespawnHours || raw.maxRespawnHours) {
    minRespawnMinutes = hoursToMinutes(raw.minRespawnHours);
    maxRespawnMinutes = hoursToMinutes(raw.maxRespawnHours);
  } else if (raw.respawnMinutes || raw.respawnHours) {
    const baseMinutes =
      raw.respawnMinutes !== undefined ? toMinutes(raw.respawnMinutes) : hoursToMinutes(raw.respawnHours);
    const varianceMinutes =
      raw.varianceMinutes !== undefined
        ? Math.max(0, Number(raw.varianceMinutes) || 0)
        : Math.max(0, Number(raw.varianceHours || 0) * 60);
    if (baseMinutes !== null) {
      minRespawnMinutes = Math.max(1, Math.round(baseMinutes - varianceMinutes));
      maxRespawnMinutes = Math.max(minRespawnMinutes + 1, Math.round(baseMinutes + varianceMinutes));
    }
  }

  if (minRespawnMinutes === null || maxRespawnMinutes === null) {
    return null;
  }

  const additionalNames = Array.from(new Set([name, ...aliases]));

  const phraseRegexes = killPhrases
    .map((phrase) => {
      if (!phrase) return null;
      return new RegExp(phrase, 'i');
    })
    .filter(Boolean);

  const autoRegexes = additionalNames.flatMap((mobName) => {
    if (!mobName) {
      return [];
    }
    const escaped = escapeRegex(mobName);
    return [
      new RegExp(`${escaped}\\s+has\\s+been\\s+slain\\s+by`, 'i'),
      new RegExp(`${escaped}\\s+has\\s+been\\s+defeated\\s+by`, 'i'),
      new RegExp(`you\\s+have\\s+slain\\s+${escaped}!`, 'i'),
    ];
  });

  return {
    id,
    name,
    aliases,
    zone: typeof raw.zone === 'string' ? raw.zone : '',
    expansion: typeof raw.expansion === 'string' ? raw.expansion : '',
    respawnDisplay: typeof raw.respawnDisplay === 'string' ? raw.respawnDisplay : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    maxSkips,
    minRespawnMinutes,
    maxRespawnMinutes,
    killMatchers: [...phraseRegexes, ...autoRegexes],
  };
}

function asDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

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

function cleanCommandTimeText(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^[,|]+\s*/, '');
  text = text.replace(/^-\s+/, '');
  return text.trim();
}

function secondsBetween(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return Math.round((endMs - startMs) / 1000);
}

function normalizeAliasKey(value) {
  if (!value && value !== 0) {
    return [];
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return [];
  }
  const collapsedWhitespace = text.replace(/\s+/g, ' ');
  const compact = collapsedWhitespace.replace(/[^a-z0-9]+/g, '');
  const dashed = collapsedWhitespace.replace(/[^a-z0-9]+/g, '-');
  const spaced = collapsedWhitespace.replace(/[^a-z0-9]+/g, ' ');
  return Array.from(new Set([collapsedWhitespace, compact, dashed, spaced.trim()])).filter(Boolean);
}

function buildAliasIndex(definitions) {
  const index = new Map();
  definitions.forEach((definition) => {
    if (!definition || !definition.id) {
      return;
    }
    const aliases = new Set([definition.name, ...(Array.isArray(definition.aliases) ? definition.aliases : [])]);
    aliases.forEach((alias) => {
      normalizeAliasKey(alias).forEach((key) => {
        if (!index.has(key)) {
          index.set(key, definition.id);
        }
      });
    });
  });
  return index;
}

const QUAKE_PATTERN = /^\^?you feel the (?:need to get somewhere safe quickly|sudden urge to seek a safe location)\.$/i;

class MobWindowManager extends EventEmitter {
  constructor(definitions = [], options = {}) {
    super();
    this.tickRateMs = Math.max(15_000, Number(options.tickRateMs) || 60_000);

    this.definitions = definitions
      .map((item) => normalizeDefinition(item))
      .filter(Boolean);

    this.definitionMap = new Map(this.definitions.map((def) => [def.id, def]));
    this.aliasIndex = buildAliasIndex(this.definitions);
    this.aliasPhrases = this.buildAliasPhraseList(this.definitions);
    this.killTimestamps = new Map();
    this.skipCounts = new Map();
    this.todHistory = new Map();
    this.tickHandle = null;
  }

  start() {
    if (this.tickHandle) {
      return;
    }
    this.tickHandle = setInterval(() => this.emitUpdate(), this.tickRateMs);
  }

  stop() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  loadState(state = {}) {
    const kills = state.kills && typeof state.kills === 'object' ? state.kills : {};
    const skips = state.skips && typeof state.skips === 'object' ? state.skips : {};
    const history = state.history && typeof state.history === 'object' ? state.history : {};
    this.killTimestamps.clear();
    this.skipCounts.clear();
    this.todHistory.clear();
    for (const [mobId, value] of Object.entries(kills)) {
      const resolvedMobId = this.resolveMobId(mobId);
      if (!resolvedMobId) {
        continue;
      }
      const parsed = asDate(value);
      if (parsed) {
        const nextMs = parsed.getTime();
        const existingMs = this.killTimestamps.get(resolvedMobId);
        if (!existingMs || nextMs > existingMs) {
          this.killTimestamps.set(resolvedMobId, nextMs);
        }
      }
    }
    for (const [mobId, value] of Object.entries(skips)) {
      const resolvedMobId = this.resolveMobId(mobId);
      if (!resolvedMobId) {
        continue;
      }
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        this.skipCounts.set(resolvedMobId, Math.floor(count));
      }
    }
    for (const [mobId, entries] of Object.entries(history)) {
      const resolvedMobId = this.resolveMobId(mobId);
      if (!resolvedMobId) {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      const parsedEntries = entries
        .map((value) => {
          if (value && typeof value === 'object' && value.timestamp) {
            const parsed = asDate(value.timestamp);
            if (!parsed) return null;
            return {
              timestampMs: parsed.getTime(),
              reportedBy:
                typeof value.reportedBy === 'string' && value.reportedBy.trim()
                  ? value.reportedBy.trim()
                  : null,
            };
          }
          const parsed = asDate(value);
          if (!parsed) return null;
          return { timestampMs: parsed.getTime(), reportedBy: null };
        })
        .filter(Boolean)
        .sort((a, b) => b.timestampMs - a.timestampMs)
        .slice(0, 10);
      if (parsedEntries.length) {
        this.todHistory.set(resolvedMobId, parsedEntries);
      }
    }
    this.emitUpdate();
  }

  resolveMobId(rawMobId) {
    if (!rawMobId && rawMobId !== 0) {
      return null;
    }
    const raw = String(rawMobId).trim();
    if (!raw) {
      return null;
    }
    if (this.definitionMap.has(raw)) {
      return raw;
    }
    const normalizedRaw = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (normalizedRaw && this.definitionMap.has(normalizedRaw)) {
      return normalizedRaw;
    }
    const aliasHit = this.lookupMobIdByAlias(raw);
    if (aliasHit) {
      return aliasHit;
    }
    return null;
  }

  serializeState() {
    const kills = {};
    for (const [mobId, timestamp] of this.killTimestamps.entries()) {
      kills[mobId] = new Date(timestamp).toISOString();
    }
    const skips = {};
    for (const [mobId, count] of this.skipCounts.entries()) {
      skips[mobId] = count;
    }
    const history = {};
    for (const [mobId, entries] of this.todHistory.entries()) {
      if (!Array.isArray(entries) || !entries.length) {
        continue;
      }
      history[mobId] = entries.slice(0, 10).map((entry) => ({
        timestamp: new Date(entry.timestampMs).toISOString(),
        reportedBy: entry.reportedBy || null,
      }));
    }
    return { kills, skips, history };
  }

  ingestLines(lines = []) {
    let changed = false;
    for (const entry of lines) {
      if (!entry || !entry.line) {
        continue;
      }
      const timestamp = entry.timestamp ? asDate(entry.timestamp) : new Date();
      changed = this.ingestLine(entry.line, timestamp) || changed;
    }
    return changed;
  }

  ingestLine(line, timestamp = new Date()) {
    if (!line) {
      return false;
    }

    const parsedTimestamp = asDate(timestamp) || new Date();
    const message = String(line).replace(/^\[[^\]]+\]\s*/, '');
    const trimmedMessage = message.trim();
    const lowered = trimmedMessage.toLowerCase();

    if (QUAKE_PATTERN.test(trimmedMessage)) {
      return this.resetAllKills(parsedTimestamp);
    }

    for (const definition of this.definitions) {
      if (!definition.killMatchers || definition.killMatchers.length === 0) {
        continue;
      }
      const matched = definition.killMatchers.some((matcher) => matcher.test(lowered));
      if (matched) {
        return this.recordKill(definition.id, parsedTimestamp);
      }
    }

    const quakeResult = this.parseQuakeCommand(trimmedMessage, parsedTimestamp);
    if (quakeResult) {
      return this.resetAllKills(quakeResult.timestamp || parsedTimestamp);
    }

    const todResult = this.parseTodCommand(trimmedMessage, parsedTimestamp);
    if (todResult) {
      if (todResult.kind === 'quake') {
        return this.resetAllKills(todResult.timestamp || parsedTimestamp);
      }
      return this.recordKill(todResult.mobId, todResult.timestamp || parsedTimestamp);
    }

    const skipResult = this.parseSkipCommand(trimmedMessage);
    if (skipResult) {
      if (skipResult.kind === 'skip') {
        return this.incrementSkip(skipResult.mobId, 1);
      }
      if (skipResult.kind === 'unskip') {
        return this.decrementSkip(skipResult.mobId, 1);
      }
    }

    const removeResult = this.parseTodRemoveCommand(trimmedMessage);
    if (removeResult) {
      return this.clearKill(removeResult.mobId);
    }

    return false;
  }

  parseTodCommand(message, fallbackTimestamp = new Date()) {
    if (!message) {
      return null;
    }
    const match = message.match(/^!?tod\s+(.+)/i);
    if (!match) {
      return null;
    }
    let remainder = match[1].trim();
    if (!remainder) {
      return null;
    }

    remainder = remainder.replace(/^[`"']+/, '').replace(/[`"']+$/, '');
    remainder = remainder.replace(/#.*$/, '').trim();
    remainder = remainder.replace(/\s+/g, ' ');
    if (!remainder) {
      return null;
    }

    const quakeMatch = remainder.match(/^quake\b/i);
    if (quakeMatch) {
      let timeText = remainder.slice(quakeMatch[0].length).trim();
      timeText = cleanCommandTimeText(timeText);
      const timestamp = resolveTemporalExpression(timeText, fallbackTimestamp, new Date());
      if (!timestamp) {
        return null;
      }
      return {
        kind: 'quake',
        timestamp,
      };
    }

    const parsedTarget = this.extractMobAndTime(remainder);
    if (!parsedTarget || !parsedTarget.mobId) {
      return null;
    }

    const timestamp = resolveTemporalExpression(parsedTarget.timeText, fallbackTimestamp, new Date());
    if (!timestamp) {
      return null;
    }

    return {
      kind: 'mob',
      mobId: parsedTarget.mobId,
      timestamp,
    };
  }

  parseQuakeCommand(message, fallbackTimestamp = new Date()) {
    if (!message) {
      return null;
    }
    const match = message.match(/^!?quake\b\s*(.*)$/i);
    if (!match) {
      return null;
    }
    const timeText = cleanCommandTimeText(match[1]);
    const timestamp = resolveTemporalExpression(timeText, fallbackTimestamp, new Date());
    if (!timestamp) {
      return null;
    }
    return {
      kind: 'quake',
      timestamp,
    };
  }

  parseSkipCommand(message) {
    if (!message) {
      return null;
    }
    const skipMatch = message.match(/^!?skip\s+(.+)/i);
    const unskipMatch = message.match(/^!?unskip\s+(.+)/i);
    const kind = skipMatch ? 'skip' : unskipMatch ? 'unskip' : null;
    const rawTarget = skipMatch ? skipMatch[1] : unskipMatch ? unskipMatch[1] : '';
    if (!kind) {
      return null;
    }
    const parsedTarget = this.extractMobAndTime(rawTarget);
    if (!parsedTarget || !parsedTarget.mobId) {
      return null;
    }
    return {
      kind,
      mobId: parsedTarget.mobId,
    };
  }

  parseTodRemoveCommand(message) {
    if (!message) {
      return null;
    }
    const match = message.match(/^!?todremove\s+(.+)/i);
    if (!match) {
      return null;
    }
    const parsedTarget = this.extractMobAndTime(match[1]);
    if (!parsedTarget || !parsedTarget.mobId) {
      return null;
    }
    return {
      mobId: parsedTarget.mobId,
    };
  }

  buildAliasPhraseList(definitions = []) {
    const phrases = [];
    const seen = new Set();
    definitions.forEach((definition) => {
      if (!definition || !definition.id) return;
      const aliases = [definition.name, ...(Array.isArray(definition.aliases) ? definition.aliases : [])];
      aliases.forEach((aliasText) => {
        const normalized = String(aliasText || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
        if (!normalized) return;
        const key = `${definition.id}:${normalized}`;
        if (seen.has(key)) return;
        seen.add(key);
        phrases.push({ mobId: definition.id, alias: normalized });
      });
    });
    phrases.sort((a, b) => b.alias.length - a.alias.length);
    return phrases;
  }

  extractMobAndTime(remainder) {
    const input = String(remainder || '').trim();
    if (!input) return null;

    const separatorIndex = input.search(/[|,]/);
    if (separatorIndex >= 0) {
      const mobText = input.slice(0, separatorIndex).trim();
      let timeText = input.slice(separatorIndex + 1).trim();
      timeText = cleanCommandTimeText(timeText);
      const mobId = this.lookupMobIdByAlias(mobText);
      if (!mobId) return null;
      return { mobId, timeText };
    }

    const exactMobId = this.lookupMobIdByAlias(input);
    if (exactMobId) {
      return { mobId: exactMobId, timeText: '' };
    }

    const lowered = input.toLowerCase();
    for (const phrase of this.aliasPhrases) {
      if (!lowered.startsWith(phrase.alias)) continue;
      if (lowered.length > phrase.alias.length) {
        const boundaryChar = lowered.charAt(phrase.alias.length);
        if (!/[\s,|#-]/.test(boundaryChar)) continue;
      }
      let timeText = input.slice(phrase.alias.length).trim();
      timeText = cleanCommandTimeText(timeText);
      return { mobId: phrase.mobId, timeText };
    }

    return null;
  }

  lookupMobIdByAlias(text) {
    if (!text) {
      return null;
    }
    const candidates = normalizeAliasKey(text);
    for (const candidate of candidates) {
      if (this.aliasIndex.has(candidate)) {
        return this.aliasIndex.get(candidate);
      }
    }
    return null;
  }

  recordKill(mobId, timestamp = new Date(), options = {}) {
    const definition = this.definitionMap.get(mobId);
    if (!definition) {
      return false;
    }
    const parsedTimestamp = asDate(timestamp);
    if (!parsedTimestamp) {
      return false;
    }
    const ms = parsedTimestamp.getTime();
    if (this.killTimestamps.get(mobId) === ms) {
      return false;
    }
    this.killTimestamps.set(mobId, ms);
    const reportedBy =
      typeof options.reportedBy === 'string' && options.reportedBy.trim()
        ? options.reportedBy.trim()
        : null;
    const history = Array.isArray(this.todHistory.get(mobId)) ? [...this.todHistory.get(mobId)] : [];
    history.unshift({ timestampMs: ms, reportedBy });
    this.todHistory.set(mobId, history.slice(0, 10));
    this.skipCounts.delete(mobId);
    this.emit('kill', {
      mobId,
      definition,
      timestamp: parsedTimestamp.toISOString(),
    });
    this.emitUpdate();
    return true;
  }

  resetAllKills(timestamp = new Date()) {
    const parsed = asDate(timestamp);
    if (!parsed) {
      return false;
    }
    const targetMs = parsed.getTime();
    let changed = false;
    for (const definition of this.definitions) {
      const existing = this.killTimestamps.get(definition.id);
      if (existing !== targetMs) {
        this.killTimestamps.set(definition.id, targetMs);
        const history = Array.isArray(this.todHistory.get(definition.id))
          ? [...this.todHistory.get(definition.id)]
          : [];
        history.unshift({ timestampMs: targetMs, reportedBy: null });
        this.todHistory.set(definition.id, history.slice(0, 10));
        changed = true;
      }
    }
    if (changed) {
      this.skipCounts.clear();
      this.emit('quake', { timestamp: parsed.toISOString() });
      this.emitUpdate();
    }
    return changed;
  }
  clearKill(mobId) {
    const existed = this.killTimestamps.delete(mobId);
    this.skipCounts.delete(mobId);
    if (existed) {
      this.emitUpdate();
    }
    return existed;
  }

  incrementSkip(mobId, amount = 1) {
    const definition = this.definitionMap.get(mobId);
    if (!definition) {
      return false;
    }
    const delta = Math.max(1, Math.floor(Number(amount) || 1));
    const current = Math.max(0, Math.floor(Number(this.skipCounts.get(mobId)) || 0));
    let next = current + delta;
    if (Number.isFinite(definition.maxSkips)) {
      next = Math.min(next, definition.maxSkips);
    }
    if (next === current) {
      return false;
    }
    this.skipCounts.set(mobId, next);
    this.emit('skip', {
      mobId,
      definition,
      skipCount: next,
    });
    this.emitUpdate();
    return true;
  }

  decrementSkip(mobId, amount = 1) {
    const definition = this.definitionMap.get(mobId);
    if (!definition) {
      return false;
    }
    const delta = Math.max(1, Math.floor(Number(amount) || 1));
    const current = Math.max(0, Math.floor(Number(this.skipCounts.get(mobId)) || 0));
    const next = Math.max(0, current - delta);
    if (next === current) {
      return false;
    }
    if (next === 0) {
      this.skipCounts.delete(mobId);
    } else {
      this.skipCounts.set(mobId, next);
    }
    this.emit('skip', {
      mobId,
      definition,
      skipCount: next,
    });
    this.emitUpdate();
    return true;
  }

  adjustSkipCount(mobId, delta = 0) {
    const parsedDelta = Math.trunc(Number(delta) || 0);
    if (parsedDelta > 0) {
      return this.incrementSkip(mobId, parsedDelta);
    }
    if (parsedDelta < 0) {
      return this.decrementSkip(mobId, Math.abs(parsedDelta));
    }
    return false;
  }

  computeSnapshot(now = Date.now()) {
    const records = this.definitions.map((definition) => {
      const lastKillMs = this.killTimestamps.get(definition.id) || null;
      const lastKillAt = lastKillMs ? new Date(lastKillMs) : null;
      const skipCount = this.skipCounts.get(definition.id) || 0;

      const minMs = definition.minRespawnMinutes * 60_000;
      const maxMs = definition.maxRespawnMinutes * 60_000;
      const baseRespawnMinutes = (definition.minRespawnMinutes + definition.maxRespawnMinutes) / 2;
      const skipOffsetMs =
        Number.isFinite(baseRespawnMinutes) && skipCount > 0 ? baseRespawnMinutes * 60_000 * skipCount : 0;

      let windowOpensAt = null;
      let windowClosesAt = null;

      if (lastKillMs) {
        windowOpensAt = new Date(lastKillMs + minMs + skipOffsetMs);
        windowClosesAt = new Date(lastKillMs + maxMs + skipOffsetMs);
      }

      const inWindow =
        windowOpensAt && windowClosesAt ? now >= windowOpensAt.getTime() && now <= windowClosesAt.getTime() : false;

      const secondsUntilOpen =
        windowOpensAt && now < windowOpensAt.getTime()
          ? secondsBetween(now, windowOpensAt.getTime())
          : 0;

      const secondsUntilClose =
        windowClosesAt && now <= windowClosesAt.getTime()
          ? secondsBetween(now, windowClosesAt.getTime())
          : 0;

      let windowProgress = null;
      if (windowOpensAt && windowClosesAt) {
        const totalWindowSeconds = secondsBetween(windowOpensAt.getTime(), windowClosesAt.getTime());
        if (totalWindowSeconds && totalWindowSeconds > 0) {
          const elapsedSeconds = totalWindowSeconds - secondsUntilClose;
          windowProgress = Math.max(
            0,
            Math.min(1, elapsedSeconds / totalWindowSeconds)
          );
        }
      }

      const secondsSinceKill = lastKillMs ? secondsBetween(lastKillMs, now) : null;

      return {
        id: definition.id,
        name: definition.name,
        aliases: definition.aliases,
        zone: definition.zone,
        expansion: definition.expansion,
        respawnDisplay: definition.respawnDisplay,
        notes: definition.notes,
        maxSkips: definition.maxSkips,
        skipCount,
        minRespawnMinutes: definition.minRespawnMinutes,
        maxRespawnMinutes: definition.maxRespawnMinutes,
        lastKillAt: lastKillAt ? lastKillAt.toISOString() : null,
        windowOpensAt: windowOpensAt ? windowOpensAt.toISOString() : null,
        windowClosesAt: windowClosesAt ? windowClosesAt.toISOString() : null,
        inWindow,
        secondsUntilOpen,
        secondsUntilClose,
        secondsSinceKill,
        windowProgress,
        todHistory: (this.todHistory.get(definition.id) || [])
          .slice(0, 10)
          .map((entry) => ({
            timestamp: new Date(entry.timestampMs).toISOString(),
            reportedBy: entry.reportedBy || null,
          })),
      };
    });

    return {
      generatedAt: new Date(now).toISOString(),
      mobs: records,
    };
  }

  emitUpdate() {
    this.emit('update', this.computeSnapshot(Date.now()));
  }

  getDefinitions() {
    return this.definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      zone: definition.zone,
      expansion: definition.expansion,
      respawnDisplay: definition.respawnDisplay,
      maxSkips: definition.maxSkips,
      minRespawnMinutes: definition.minRespawnMinutes,
      maxRespawnMinutes: definition.maxRespawnMinutes,
      notes: definition.notes,
    }));
  }
}

module.exports = MobWindowManager;
