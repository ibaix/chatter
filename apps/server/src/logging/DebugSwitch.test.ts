import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogging, currentLogLevel } from './logger.js';
import { DebugSwitch } from './DebugSwitch.js';
import { captureLog, type CapturedLog } from './testSupport.js';

describe('DebugSwitch', () => {
  let log: CapturedLog;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
    log = captureLog();
    configureLogging({ level: 'info' });
  });

  afterEach(() => {
    log.restore();
    vi.useRealTimers();
  });

  it('turns the debug level on, and off by itself after the time', () => {
    const debug = new DebugSwitch(Date.now, 15 * 60_000);
    expect(debug.turnOn('admin')).toEqual({ debugUntil: '2026-11-12T10:15:00.000Z' });
    expect(currentLogLevel()).toBe('debug');
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(currentLogLevel()).toBe('debug');
    vi.advanceTimersByTime(1);
    expect(currentLogLevel()).toBe('info');
    expect(debug.state).toEqual({ debugUntil: null });
    expect(log.text()).toContain('Debug level on user=admin minutes=15');
    expect(log.text()).toContain('Debug level off by=time');
  });

  it('a second turn on gives the whole time again, and the old level comes back', () => {
    configureLogging({ level: 'warn' });
    const debug = new DebugSwitch(Date.now, 60_000);
    debug.turnOn('admin');
    vi.advanceTimersByTime(30_000);
    debug.turnOn('admin');
    vi.advanceTimersByTime(59_000);
    expect(currentLogLevel()).toBe('debug');
    vi.advanceTimersByTime(1000);
    expect(currentLogLevel()).toBe('warn');
  });

  it('turns off at once', () => {
    const debug = new DebugSwitch();
    debug.turnOn('admin');
    expect(debug.turnOff('admin')).toEqual({ debugUntil: null });
    expect(currentLogLevel()).toBe('info');
    expect(vi.getTimerCount()).toBe(0);
  });
});
