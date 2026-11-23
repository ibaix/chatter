import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServerLog } from './startServerLog.js';

describe('startServerLog', () => {
  let folder: string;
  let stopListening = () => {};

  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'server-log-'));
  });
  afterEach(() => {
    stopListening();
    rmSync(folder, { recursive: true, force: true });
  });

  it('stops Chatter on each kind of crash, one time for each kind', () => {
    const target = new EventEmitter();

    ({ stopListening } = startServerLog(folder, { target, environment: { LOG_FILE: 'off' }, exit: vi.fn() }));

    expect(target.listenerCount('uncaughtException')).toBe(1);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
  });

  it('writes the crash to the log file before it stops, so Settings > Diagnostics shows it after the restart', async () => {
    const target = new EventEmitter();
    const logFile = path.join(folder, 'logs', 'chatter.log');
    // The text of the file at the time of the stop
    let textAtExit = '';
    const exit = vi.fn<(code: number) => void>(() => { textAtExit = readFileSync(logFile, 'utf-8'); });
    let serverLog;
    ({ serverLog, stopListening } = startServerLog(folder, { target, environment: {}, exit }));

    target.emit('uncaughtException', new Error('socket hang up'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(serverLog.filePaths).toContain(logFile);
    expect(textAtExit).toContain('socket hang up');
  });
});
