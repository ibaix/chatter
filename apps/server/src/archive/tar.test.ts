import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTar, tarBytes, TarFormatError, type TarEntry } from './tar.js';

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

  it('fills a file that became shorter after its header with zeros, so the tar stays correct', async () => {
    const log = path.join(folder, 'chatter.log');
    writeFileSync(log, Buffer.alloc(3000, 'a'));
    const parts: Uint8Array[] = [];
    for await (const part of tarBytes([{ name: 'chatter.log', filePath: log }, { name: 'after.txt', text: 'after' }])) {
      // The header is out: the file becomes shorter before its bytes are read
      if (parts.length === 0) truncateSync(log, 1000);
      parts.push(part);
    }
    const tarFile = path.join(folder, 'out.tar');
    writeFileSync(tarFile, Buffer.concat(parts));
    const out = path.join(folder, 'out');
    mkdirSync(out);
    execFileSync('tar', ['-xf', tarFile, '-C', out]);
    expect(readFileSync(path.join(out, 'chatter.log')).equals(Buffer.concat([Buffer.alloc(1000, 'a'), Buffer.alloc(2000)]))).toBe(true);
    expect(readFileSync(path.join(out, 'after.txt'), 'utf8')).toBe('after');
  });

  it('leaves out a file on the disk that is gone', async () => {
    const tar = await tarOf([{ name: 'gone.log', filePath: path.join(folder, 'gone.log') }]);
    expect(tar.length).toBe(1024);
  });
});

describe('readTar', () => {
  /** The entries of a tar, read in pieces of `pieceBytes`, as name → text */
  async function entriesOf(tar: Buffer, pieceBytes = 100): Promise<Map<string, string>> {
    async function* pieces() {
      for (let at = 0; at < tar.length; at += pieceBytes) yield tar.subarray(at, at + pieceBytes);
    }
    const found = new Map<string, string>();
    await readTar(pieces(), async ({ name, size }) => {
      const parts: Buffer[] = [];
      return {
        write: async part => {
          parts.push(part);
        },
        end: async () => {
          const text = Buffer.concat(parts);
          expect(text.length).toBe(size);
          found.set(name, text.toString('utf8'));
        },
      };
    });
    return found;
  }

  it('reads back what tarBytes writes, in pieces of any size', async () => {
    const long = 'x'.repeat(1500);
    const tar = await tarOf([{ name: 'manifest.json', text: '{}' }, { name: 'a/b.txt', text: long }, { name: 'empty', text: '' }]);
    for (const pieceBytes of [1, 7, 512, 100_000]) {
      expect(await entriesOf(tar, pieceBytes)).toEqual(new Map([['manifest.json', '{}'], ['a/b.txt', long], ['empty', '']]));
    }
  });

  it('reads a tar that the tar program made', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'tar-'));
    try {
      writeFileSync(path.join(folder, 'one.txt'), 'one\n');
      const tar = execFileSync('tar', ['--format', 'ustar', '-cf', '-', '-C', folder, 'one.txt']);
      expect(await entriesOf(tar)).toEqual(new Map([['one.txt', 'one\n']]));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses a tar that ends too soon', async () => {
    const tar = await tarOf([{ name: 'a.txt', text: 'y'.repeat(2000) }]);
    await expect(entriesOf(tar.subarray(0, 1200))).rejects.toThrow(TarFormatError);
    await expect(entriesOf(tar.subarray(0, 512 + 2048))).rejects.toThrow('ends too soon');
  });

  it('refuses a header with a wrong checksum', async () => {
    const tar = await tarOf([{ name: 'a.txt', text: 'abc' }]);
    tar[0] = 'b'.charCodeAt(0);
    await expect(entriesOf(tar)).rejects.toThrow('checksum');
  });

  it('refuses an entry that is not a regular file, for example a link or a folder', async () => {
    const tar = await tarOf([{ name: 'a.txt', text: 'abc' }]);
    tar.write('2', 156);
    rewriteChecksum(tar);
    await expect(entriesOf(tar)).rejects.toThrow('only regular files');
  });

  it('refuses a name in the prefix field', async () => {
    const tar = await tarOf([{ name: 'a.txt', text: 'abc' }]);
    tar.write('../../etc', 345);
    rewriteChecksum(tar);
    await expect(entriesOf(tar)).rejects.toThrow('long name');
  });
});

/** Put the right checksum in the first header after a change */
function rewriteChecksum(tar: Buffer): void {
  tar.write('        ', 148);
  const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148);
}
