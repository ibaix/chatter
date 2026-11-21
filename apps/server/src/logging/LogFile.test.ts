import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogFile } from './LogFile.js';

describe('LogFile', () => {
  let folder: string;
  let filePath: string;

  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'log-file-'));
    filePath = path.join(folder, 'logs', 'chatter.log');
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('makes the folder, and adds each line to the file', async () => {
    const file = new LogFile(filePath);
    file.write('one');
    file.write('two');
    await file.close();
    expect(readFileSync(filePath, 'utf8')).toBe('one\ntwo\n');
  });

  it('adds to the lines from before a restart', async () => {
    const first = new LogFile(filePath);
    first.write('before');
    await first.close();
    const second = new LogFile(filePath);
    second.write('after');
    await second.close();
    expect(readFileSync(filePath, 'utf8')).toBe('before\nafter\n');
  });

  it('keeps one old file when the file is full, so the log never takes more than 2 files', async () => {
    const file = new LogFile(filePath, 9);
    for (const text of ['aaaa', 'bbbb', 'cccc', 'dddd']) file.write(text);
    await file.close();
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('cccc\n');
    expect(readFileSync(filePath, 'utf8')).toBe('dddd\n');
    expect(file.filePaths).toEqual([`${filePath}.1`, filePath]);
  });

  it('a file that cannot be written does not throw, and writes nothing more', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A file where the folder must be, so the folder cannot be made
    writeFileSync(path.join(folder, 'logs'), 'not a folder');
    const file = new LogFile(filePath);
    expect(() => file.write('one')).not.toThrow();
    expect(() => file.write('two')).not.toThrow();
    await file.close();
    expect(existsSync(filePath)).toBe(false);
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
  });
});
