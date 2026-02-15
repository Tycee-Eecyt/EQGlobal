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
    this.killTimestamps = new Map();
    this.skipCounts = new Map();
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
    this.killTimestamps.clear();
    this.skipCounts.clear();
    for (const [mobId, value] of Object.entries(kills)) {
      const parsed = asDate(value);
      if (parsed) {
        this.killTimestamps.set(mobId, parsed.getTime());
      }
    }
    for (const [mobId, value] of Object.entries(skips)) {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        this.skipCounts.set(mobId, Math.floor(count));
      }
    }
    this.emitUpdate();
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
    return { kills, skips };
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

    const todResult = this.parseTodCommand(trimmedMessage, parsedTimestamp);
    if (todResult) {
      return this.recordKill(todResult.mobId, todResult.timestamp || parsedTimestamp);
    }

    return false;
  }

  parseTodCommand(message, fallbackTimestamp = new Date()) {
    if (!message) {
      return null;
    }
    const match = message.match(/!tod\s+(.+)/i);
    if (!match) {
      return null;
    }
    let remainder = match[1].trim();
    if (!remainder) {
      return null;
    }

    remainder = remainder.replace(/^[`"'â€œâ€â€˜â€™]+/, '').replace(/[`"'â€œâ€â€˜â€™]+$/, '');
    remainder = remainder.replace(/#.*$/, '').trim();

    let explicitTime = null;
    const nowMatch = remainder.match(/(?:^|[\s,|])now[.!?]?$/i);
    if (nowMatch) {
      explicitTime = 'now';
      remainder = remainder.slice(0, nowMatch.index).trim();
    }

    remainder = remainder.replace(/[,|]+$/, '').trim();
    if (!remainder) {
      return null;
    }

    const mobId = this.lookupMobIdByAlias(remainder);
    if (!mobId) {
      return null;
    }

    const timestamp = explicitTime === 'now' ? fallbackTimestamp : null;
    return {
      mobId,
      timestamp,
    };
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

  recordKill(mobId, timestamp = new Date()) {
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
