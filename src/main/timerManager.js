const { EventEmitter } = require('events');

class TimerManager extends EventEmitter {
  constructor({ tickRateMs = 500 } = {}) {
    super();
    this.tickRateMs = tickRateMs;
    this.timers = new Map();
    this.interval = null;
  }

  start() {
    if (!this.interval) {
      this.interval = setInterval(() => this.tick(), this.tickRateMs);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.timers.clear();
    this.emitUpdate();
  }

  addTimer(triggerPayload) {
    const { trigger, timestamp = new Date() } = triggerPayload;

    if (!trigger || !trigger.duration) {
      return null;
    }

    const id = `${trigger.id || trigger.label}-${Date.now()}`;
    const startsAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const expiresAt = new Date(startsAt.getTime() + trigger.duration * 1000);

    const timer = {
      id,
      label: trigger.label || trigger.id || trigger.pattern,
      color: trigger.color || '#00c9ff',
      duration: trigger.duration,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      triggerId: trigger.id,
      triggerPattern: trigger.pattern,
    };

    this.timers.set(id, timer);
    this.emitUpdate();
    this.start();
    return timer;
  }

  removeTimer(timerId) {
    if (this.timers.delete(timerId)) {
      this.emitUpdate();
    }
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const [id, timer] of this.timers.entries()) {
      const expiresAt = Date.parse(timer.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= now) {
        this.timers.delete(id);
        changed = true;
      }
    }

    if (changed) {
      this.emitUpdate();
    }

    if (this.timers.size === 0) {
      this.stop();
    }
  }

  getTimers() {
    const now = Date.now();
    return Array.from(this.timers.values())
      .map((timer) => {
        const expiresAt = Date.parse(timer.expiresAt);
        const remainingMs = Math.max(0, expiresAt - now);
        return {
          ...timer,
          remainingMs,
          remainingSeconds: Math.ceil(remainingMs / 1000),
        };
      })
      .sort((a, b) => a.remainingMs - b.remainingMs);
  }

  emitUpdate() {
    this.emit('update', this.getTimers());
  }
}

module.exports = TimerManager;
