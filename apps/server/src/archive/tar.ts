import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * A small writer and reader of tar files (the ustar format), for the support bundle and the history backup.
 * The files go out one after the other, so a log file is read in parts and never held whole in memory.
 */

const BLOCK = 512;

/** A file of the tar: a small text in memory, or a file on the disk that is read when its turn comes */
export type TarEntry = { name: string; text: string } | { name: string; filePath: string };

/** The tar, as a stream of bytes. A file on the disk that is gone is left out. */
export async function* tarBytes(entries: TarEntry[], now = new Date()): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    if ('text' in entry) {
      const data = Buffer.from(entry.text, 'utf8');
      yield header(entry.name, data.length, now);
      yield data;
      yield padding(data.length);
    } else {
      // The size at this time: a log file can grow while it is read, so only this many bytes are read
      const size = await stat(entry.filePath).then(stats => (stats.isFile() ? stats.size : null), () => null);
      if (size === null) continue;
      yield header(entry.name, size, now);
      let sent = 0;
      if (size > 0) {
        for await (const chunk of createReadStream(entry.filePath, { start: 0, end: size - 1 })) {
          sent += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      // A file that became shorter is filled with zeros, so the tar stays correct
      if (sent < size) yield Buffer.alloc(size - sent);
      yield padding(size);
    }
  }
  yield Buffer.alloc(2 * BLOCK);
}

function padding(size: number): Uint8Array {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** The ustar header of a regular file. Each name in the bundle is short (less than 100 characters). */
function header(name: string, size: number, time: Date): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 99), 0, 'utf8');
  block.write(octal(0o644, 7), 100);
  block.write(octal(0, 7), 108);
  block.write(octal(0, 7), 116);
  block.write(octal(size, 11), 124);
  block.write(octal(Math.floor(time.getTime() / 1000), 11), 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\u000000', 257);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${octal(checksum, 6)}\u0000 `, 148);
  return block;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}
