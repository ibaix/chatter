import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readTar, tarBytes } from '../archive/tar.js';
import type { Manifest } from './archive.js';

/** For tests: the entries of a .tar.gz, in their order */
export async function unpack(archive: Uint8Array): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const tar = gunzipSync(archive);
  await readTar((async function* () {
    yield tar;
  })(), async ({ name }) => {
    const parts: Buffer[] = [];
    return {
      write: async part => {
        parts.push(part);
      },
      end: async () => {
        entries.set(name, Buffer.concat(parts));
      },
    };
  });
  return entries;
}

/** For tests: a .tar.gz of the entries. Texts are written as they are, so a test can make a broken file. A name can come two times. */
export async function pack(entries: Iterable<[string, Buffer | string]>): Promise<Buffer> {
  // tarBytes reads binary parts from files
  const folder = mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  try {
    const tarEntries = [...entries].map(([name, data], index) => {
      const filePath = path.join(folder, String(index));
      writeFileSync(filePath, data);
      return { name, filePath };
    });
    const pieces: Uint8Array[] = [];
    for await (const piece of tarBytes(tarEntries, new Date(0))) pieces.push(piece);
    return gzipSync(Buffer.concat(pieces));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * For tests: change a part or the manifest of a good archive.
 * By default the manifest gets the new size, sha256 and count of each changed part, so only the change is wrong.
 */
export async function changeArchive(
  archive: Uint8Array,
  change: (entries: Map<string, Buffer>, manifest: Manifest) => void,
  { fixHashes = true } = {},
): Promise<Buffer> {
  const entries = await unpack(archive);
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Manifest;
  change(entries, manifest);
  if (fixHashes) {
    for (const [name, facts] of Object.entries(manifest.parts)) {
      const data = entries.get(name);
      if (data) Object.assign(facts!, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  if (entries.has('manifest.json')) entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return pack(entries);
}

/** For tests: the JSONL lines of a gzip part */
export function linesOf(part: Buffer): string[] {
  return gunzipSync(part).toString('utf8').split('\n').filter(Boolean);
}

/** For tests: a gzip part from JSONL lines */
export function partOf(lines: string[]): Buffer {
  return gzipSync(Buffer.from(lines.map(line => `${line}\n`).join(''), 'utf8'));
}
