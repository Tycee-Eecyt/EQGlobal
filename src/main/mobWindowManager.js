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

class MobWindowManager extends EventEmitter {
  constructor(definitions = [], options = {}) {
    super();
    this.tickRateMs = Math.max(15_000, Number(options.tickRateMs) || 60_000);

    this.definitions = definitions
      .map((item) => normalizeDefinition(item))
      .filter(Boolean);

    this.definitionMap = new Map(this.definitions.map((def) => [def.id, def]));
    this.killTimestamps = new Map();
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
    this.killTimestamps.clear();
    for (const [mobId, value] of Object.entries(kills)) {
      const parsed = asDate(value);
      if (parsed) {
        this.killTimestamps.set(mobId, parsed.getTime());
      }
    }
    this.emitUpdate();
  }

  serializeState() {
    const kills = {};
    for (const [mobId, timestamp] of this.killTimestamps.entries()) {
      kills[mobId] = new Date(timestamp).toISOString();
    }
    return { kills };
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
    const lowered = message.toLowerCase();

    for (const definition of this.definitions) {
      if (!definition.killMatchers || definition.killMatchers.length === 0) {
        continue;
      }
      const matched = definition.killMatchers.some((matcher) => matcher.test(lowered));
      if (matched) {
        return this.recordKill(definition.id, parsedTimestamp);
      }
    }

    return false;
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
    this.emit('kill', {
      mobId,
      definition,
      timestamp: parsedTimestamp.toISOString(),
    });
    this.emitUpdate();
    return true;
  }

  clearKill(mobId) {
    const existed = this.killTimestamps.delete(mobId);
    if (existed) {
      this.emitUpdate();
    }
    return existed;
  }

  computeSnapshot(now = Date.now()) {
    const records = this.definitions.map((definition) => {
      const lastKillMs = this.killTimestamps.get(definition.id) || null;
      const lastKillAt = lastKillMs ? new Date(lastKillMs) : null;

      const minMs = definition.minRespawnMinutes * 60_000;
      const maxMs = definition.maxRespawnMinutes * 60_000;

      let windowOpensAt = null;
      let windowClosesAt = null;

      if (lastKillMs) {
        windowOpensAt = new Date(lastKillMs + minMs);
        windowClosesAt = new Date(lastKillMs + maxMs);
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
      minRespawnMinutes: definition.minRespawnMinutes,
      maxRespawnMinutes: definition.maxRespawnMinutes,
      notes: definition.notes,
    }));
  }
}

module.exports = MobWindowManager;
