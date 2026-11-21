import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tarBytes, type TarEntry } from './tar.js';

async function tarOf(entries: TarEntry[]): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of tarBytes(entries, new Date('2026-11-21T10:00:00Z'))) parts.push(part);
  return Buffer.concat(parts);
}

describe('tarBytes', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'tar-'));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('writes texts and files on the disk that the tar program can read', async () => {
    const big = path.join(folder, 'big.bin');
    const content = Buffer.alloc(70_000, 7);
    writeFileSync(big, content);
    const tarFile = path.join(folder, 'out.tar');
    writeFileSync(tarFile, await tarOf([{ name: 'manifest.json', text: '{"a":1}\n' }, { name: 'history/big.bin', filePath: big }]));

    expect(execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' }).trim().split('\n')).toEqual(['manifest.json', 'history/big.bin']);
    const out = path.join(folder, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-xf', tarFile, '-C', out]);
    expect(readFileSync(path.join(out, 'manifest.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(path.join(out, 'history/big.bin')).equals(content)).toBe(true);
  });

  it('leaves out a file on the disk that is gone', async () => {
    const tar = await tarOf([{ name: 'gone.log', filePath: path.join(folder, 'gone.log') }]);
    expect(tar.length).toBe(1024);
  });
});
