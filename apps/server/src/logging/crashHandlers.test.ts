import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLog, type CapturedLog } from './testSupport.js';
import { CRASH_FLUSH_TIME_LIMIT_MS, stopOnCrash } from './crashHandlers.js';

describe('stopOnCrash', () => {
  let log: CapturedLog;
  let target: EventEmitter;
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>;

  beforeEach(() => {
    log = captureLog();
    target = new EventEmitter();
    exit = vi.fn<(code: number) => void>();
  });
  afterEach(() => {
    log.restore();
    vi.useRealTimers();
  });

  it('logs an exception that nothing caught, with its stack, then writes the log file and stops with code 1', async () => {
    const flushLog = vi.fn(async () => {});
    stopOnCrash({ target, flushLog, exit });

    target.emit('uncaughtException', new Error('socket hang up'));

    expect(log.text('error')).toContain('socket hang up');
    expect(log.text('error')).toMatch(/\n\s+at /);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(flushLog).toHaveBeenCalledOnce();
  });

  it('logs a promise that failed and that nothing caught, then stops with code 1', async () => {
    stopOnCrash({ target, exit });

    target.emit('unhandledRejection', new Error('ECONNRESET'));

    expect(log.text('error')).toContain('ECONNRESET');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('logs a failure value that is not an Error', async () => {
    stopOnCrash({ target, exit });

    target.emit('unhandledRejection', 'plain text');

    expect(log.text('error')).toContain('plain text');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('stops after the time limit when the log file does not end', async () => {
    vi.useFakeTimers();
    stopOnCrash({ target, flushLog: () => new Promise(() => {}), exit });

    target.emit('uncaughtException', new Error('stuck'));
    await vi.advanceTimersByTimeAsync(CRASH_FLUSH_TIME_LIMIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stops when the log file fails', async () => {
    stopOnCrash({ target, flushLog: async () => { throw new Error('disk full'); }, exit });

    target.emit('uncaughtException', new Error('first'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('logs a second error during the stop, and stops only one time', async () => {
    stopOnCrash({ target, exit });

    target.emit('uncaughtException', new Error('first'));
    target.emit('uncaughtException', new Error('second'));

    expect(log.text('error')).toContain('second');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(exit).toHaveBeenCalledOnce();
  });
});
