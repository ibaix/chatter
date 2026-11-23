import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SERVER_FOLDER = path.resolve(import.meta.dirname, '..');

describe('npm run reset-password (the script)', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'reset-password-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('stops with exit code 1 when the input is not a terminal', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/resetPassword.ts'], {
      cwd: SERVER_FOLDER,
      input: 'boss\n',
      encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: path.join(folder, 'chatter.db') },
      timeout: 30_000,
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('reset-password needs a terminal');
  });
});
