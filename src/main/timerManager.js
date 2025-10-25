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

    const restartMode = trigger?.timer?.restartMode || 'restart-current';
    const triggerKey = trigger.id || trigger.label || trigger.pattern;
    const timerName =
      (trigger.timer && trigger.timer.name) || trigger.label || trigger.id || trigger.pattern;
    const timerType = trigger?.timer?.type || 'countdown';

    const existingTimers = [];
    for (const timer of this.timers.values()) {
      if (timer.triggerId === triggerKey) {
        existingTimers.push(timer);
      }
    }

    if (restartMode === 'ignore' && existingTimers.length > 0) {
      return existingTimers[0];
    }

    const startsAt = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const expiresAt = new Date(startsAt.getTime() + trigger.duration * 1000);

    if (restartMode === 'restart-current' && existingTimers.length > 0) {
      const current = existingTimers[0];
      const updated = {
        ...current,
        duration: trigger.duration,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        timerType,
        timerName,
        restartMode,
      };
      this.timers.set(current.id, updated);
      for (let i = 1; i < existingTimers.length; i += 1) {
        this.timers.delete(existingTimers[i].id);
      }
      this.emitUpdate();
      this.start();
      return updated;
    }

    const id = `${triggerKey}-${Date.now()}`;
    const timer = {
      id,
      label: trigger.label || trigger.id || trigger.pattern,
      color: trigger.color || '#00c9ff',
      duration: trigger.duration,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      triggerId: triggerKey,
      triggerPattern: trigger.pattern,
      timerName,
      timerType,
      restartMode,
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
    for (const [id, timer] of this.timers.entries()) {
      const expiresAt = Date.parse(timer.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= now) {
        this.timers.delete(id);
      }
    }

    // Always emit updates while timers are active so UIs can animate countdowns.
    if (this.timers.size > 0) {
      this.emitUpdate();
    } else {
      // When no timers remain, stop the interval and emit a final update via stop().
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
