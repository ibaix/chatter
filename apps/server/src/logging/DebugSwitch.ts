import { configureLogging, createLogger, currentLogLevel, type LogLevel } from './logger.js';

const log = createLogger('diagnostics');

/** The debug level writes many lines. So it turns itself off after this time. */
const DEBUG_TIME_MS = 15 * 60_000;

export interface DebugState {
  /** When the debug level turns off by itself (ISO text), or null while it is off */
  debugUntil: string | null;
}

/**
 * Settings > Diagnostics: "Debug level for 15 minutes". The server writes debug lines too, for a short time,
 * then goes back to its usual level (LOG_LEVEL), also when nobody turns it off.
 */
export class DebugSwitch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private until: number | null = null;
  private levelBefore: LogLevel = 'info';

  constructor(private readonly now: () => number = Date.now, private readonly durationMs = DEBUG_TIME_MS) {}

  get state(): DebugState {
    return { debugUntil: this.until === null ? null : new Date(this.until).toISOString() };
  }

  /** On for the whole time again, also when it is on already */
  turnOn(username: string): DebugState {
    if (this.timer === null) this.levelBefore = currentLogLevel();
    else clearTimeout(this.timer);
    configureLogging({ level: 'debug' });
    this.until = this.now() + this.durationMs;
    this.timer = setTimeout(() => this.turnOff('time'), this.durationMs);
    // The timer must not keep the server running at a stop
    this.timer.unref?.();
    log.info('Debug level on', { user: username, minutes: Math.round(this.durationMs / 60_000) });
    return this.state;
  }

  turnOff(by: string): DebugState {
    if (this.timer === null) return this.state;
    clearTimeout(this.timer);
    this.timer = null;
    this.until = null;
    configureLogging({ level: this.levelBefore });
    log.info('Debug level off', { by });
    return this.state;
  }
}
