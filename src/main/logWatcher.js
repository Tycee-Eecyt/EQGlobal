const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { sanitizeRegexPattern } = require('../shared/regex');
const chokidar = require('chokidar');

const NEWLINE_REGEXP = /\r?\n/;
const SUPPORTED_EXTENSIONS = ['.log', '.txt'];
const DEFAULT_FILE_PATTERNS = ['*.log', 'eqlog_*.txt'];

function parseTsToSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const compact = text.toLowerCase().replace(/\s+/g, '');

  const hhmmss = compact.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hhmmss) {
    const hours = Number(hhmmss[1]);
    const minutes = Number(hhmmss[2]);
    const seconds = Number(hhmmss[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return Math.max(1, hours * 3600 + minutes * 60 + seconds);
  }

  const mmss = compact.match(/^(\d{1,2}):(\d{2})$/);
  if (mmss) {
    const minutes = Number(mmss[1]);
    const seconds = Number(mmss[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return Math.max(1, minutes * 60 + seconds);
  }

  const valueWithUnit = compact.match(
    /^(\d+(?:\.\d+)?)(ms|msec|millisecond(?:s)?|s|sec|secs|second(?:s)?|m|min|mins|minute(?:s)?|h|hr|hrs|hour(?:s)?|d|day(?:s)?)?$/
  );
  if (!valueWithUnit) return null;

  const amount = Number(valueWithUnit[1]);
  const unit = valueWithUnit[2] || 's';
  if (!Number.isFinite(amount) || amount <= 0) return null;

  if (unit.startsWith('ms') || unit.startsWith('msec') || unit.startsWith('millisecond')) {
    return Math.max(1, Math.round(amount / 1000));
  }
  if (unit === 's' || unit.startsWith('sec') || unit.startsWith('second')) {
    return Math.max(1, Math.round(amount));
  }
  if (unit === 'm' || unit.startsWith('min') || unit.startsWith('minute')) {
    return Math.max(1, Math.round(amount * 60));
  }
  if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) {
    return Math.max(1, Math.round(amount * 3600));
  }
  if (unit === 'd' || unit.startsWith('day')) {
    return Math.max(1, Math.round(amount * 86400));
  }
  return null;
}

function isSupportedLogFile(fileName = '') {
  const lower = fileName.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return false;
  }

  // EverQuest logs usually start with eqlog_
  if (lower.endsWith('.txt') && !lower.startsWith('eqlog_')) {
    return false;
  }

  return true;
}

function normalizeGlobPath(directory, pattern) {
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  if (!normalizedPattern) {
    return normalizedDir || '.';
  }
  return `${normalizedDir}/${normalizedPattern}`;
}

class LogWatcher extends EventEmitter {
  constructor(logDirectory, triggers = [], options = {}) {
    super();
    this.logDirectory = logDirectory;
    this.triggers = [];
    this.options = {
      filePatterns:
        Array.isArray(options.filePatterns) && options.filePatterns.length > 0
          ? options.filePatterns
          : DEFAULT_FILE_PATTERNS,
      watchOptions: {
        usePolling: true,
        interval: 300,
        binaryInterval: 500,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
        ...options.watchOptions,
      },
      encoding: options.encoding || 'utf8',
    };

    this.watcher = null;
    this.filePositions = new Map();
    this.readLocks = new Map();

    this.setTriggers(triggers);
  }

  setTriggers(triggers = []) {
    this.triggers = triggers.map((trigger) => {
      let matcher;
      let compiled = null;
      if (trigger.isRegex) {
        const flags = trigger.flags || 'i';
        const original = String(trigger.pattern || '');
        const sanitized = sanitizeRegexPattern(original);
        try {
          compiled = new RegExp(sanitized, flags);
        } catch (err) {
          // Fallback: use plain substring match if regex is invalid even after sanitization
          compiled = null;
        }
        if (compiled) {
          matcher = (line) => compiled.test(line);
        } else {
          const needle = original.toLowerCase();
          matcher = (line) => line.toLowerCase().includes(needle);
        }
      } else {
        matcher = (line) => line.toLowerCase().includes((trigger.pattern || '').toLowerCase());
      }

      return {
        id: trigger.id || trigger.label || trigger.pattern,
        ...trigger,
        compiledRegex: trigger.isRegex ? compiled : null,
        hasTsPlaceholder:
          String(trigger.dynamicDuration || '').toLowerCase() === 'ts' ||
          /\{ts\}/i.test(String(trigger.pattern || '')),
        matcher,
      };
    });
  }

  async start() {
    if (this.watcher) {
      return;
    }

    const normalizedDirectory = normalizeGlobPath(this.logDirectory, '');

    this.watcher = chokidar.watch(normalizedDirectory, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
      ...this.options.watchOptions,
      ignored: (watchedPath) => {
        if (!watchedPath) {
          return false;
        }
        const fileName = path.basename(watchedPath);
        if (!fileName || !path.extname(fileName)) {
          return false;
        }
        return !isSupportedLogFile(fileName);
      },
    });

    this.watcher.on('add', (filePath) => {
      if (isSupportedLogFile(path.basename(filePath))) {
        this.prepareFile(filePath);
      }
    });
    this.watcher.on('change', (filePath) => {
      if (isSupportedLogFile(path.basename(filePath))) {
        this.processFileChange(filePath);
      }
    });
    this.watcher.on('error', (error) => this.emit('error', error));

    // Prime existing files
    const existingFiles = await fs.promises.readdir(this.logDirectory);
    await Promise.all(
      existingFiles
        .filter((file) => isSupportedLogFile(file))
        .map((file) => this.prepareFile(path.join(this.logDirectory, file)))
    );

    this.emit('status', { state: 'watching', directory: this.logDirectory });
  }

  async prepareFile(filePath) {
    try {
      const stats = await fs.promises.stat(filePath);
      this.filePositions.set(filePath, stats.size);
      this.emit('file', { filePath, event: 'ready' });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async processFileChange(filePath) {
    const previousLock = this.readLocks.get(filePath);
    if (previousLock) {
      // Ensure we run again after the current read completes.
      this.readLocks.set(filePath, previousLock.then(() => this.readNewContent(filePath)));
      return;
    }

    const readPromise = this.readNewContent(filePath);
    this.readLocks.set(filePath, readPromise);
    try {
      await readPromise;
    } finally {
      this.readLocks.delete(filePath);
    }
  }

  async readNewContent(filePath) {
    let previousPosition = this.filePositions.get(filePath) || 0;

    let handle;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stats = await handle.stat();

      if (stats.size < previousPosition) {
        // File rotated/truncated.
        previousPosition = 0;
      }

      if (stats.size === previousPosition) {
        return;
      }

      const length = stats.size - previousPosition;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, previousPosition);
      this.filePositions.set(filePath, stats.size);

      const raw = buffer.toString(this.options.encoding);
      const lines = raw.split(NEWLINE_REGEXP).filter(Boolean);

      if (lines.length > 0) {
        this.emit('lines', { filePath, lines });
      }

      for (const line of lines) {
        const match = this.matchLine(line);
        if (match) {
          this.emit('trigger', {
            filePath,
            line,
            trigger: match.trigger,
            timestamp: match.timestamp,
            message: match.message,
          });
        }
      }
    } catch (error) {
      this.emit('error', error);
    } finally {
      if (handle) {
        await handle.close();
      }
    }
  }

  matchLine(line) {
    const parsed = this.parseLine(line);
    if (!parsed) {
      return null;
    }

    for (const trigger of this.triggers) {
      try {
        if (trigger.compiledRegex) {
          const match = trigger.compiledRegex.exec(parsed.message);
          if (match) {
            if (trigger.hasTsPlaceholder) {
              const tsValue = match?.groups?.ts;
              const tsSeconds = parseTsToSeconds(tsValue);
              if (tsSeconds && tsSeconds > 0) {
                return {
                  trigger: { ...trigger, duration: tsSeconds, matchGroups: match?.groups || {} },
                  ...parsed,
                };
              }
            }
            return { trigger: { ...trigger, matchGroups: match?.groups || {} }, ...parsed };
          }
          continue;
        }

        if (trigger.matcher(parsed.message)) {
          return { trigger, ...parsed };
        }
      } catch (error) {
        this.emit('error', error);
      }
    }

    return null;
  }

  parseLine(line) {
    const match = line.match(/^\[(.+?)\]\s*(.*)$/);
    if (!match) {
      return {
        raw: line,
        message: line,
        timestamp: new Date(),
      };
    }

    const [, timestampText, message] = match;
    const timestamp = Number.isNaN(Date.parse(timestampText))
      ? new Date()
      : new Date(timestampText);

    return {
      raw: line,
      message,
      timestamp,
    };
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.filePositions.clear();
      this.readLocks.clear();
      this.emit('status', { state: 'stopped' });
    }
  }
}

module.exports = LogWatcher;
