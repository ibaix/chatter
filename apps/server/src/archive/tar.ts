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

/** The tar is broken, or it has an entry that the reader does not take */
export class TarFormatError extends Error {}

export interface TarEntryHeader {
  name: string;
  size: number;
}

/** Where the bytes of one entry go. A throw stops the read. */
export interface TarEntrySink {
  write(part: Buffer): Promise<void>;
  end(): Promise<void>;
}

/** The type flags of a regular file: '0', and NUL in old tars */
const REGULAR_FILE_FLAGS = new Set([0x30, 0x00]);
const PREFIX_AT = 345;

/**
 * Read a tar from a stream, entry by entry, so a large entry never sits in memory.
 * `onEntry` gets the name and the size before the bytes, so it can refuse an entry before it reads it.
 * Takes only regular files with a short name (no links, folders, or extended headers).
 */
export async function readTar(source: AsyncIterable<Uint8Array>, onEntry: (entry: TarEntryHeader) => Promise<TarEntrySink>): Promise<void> {
  const bytes = new ByteQueue(source);
  for (;;) {
    const block = await bytes.take(BLOCK);
    if (block.every(byte => byte === 0)) return;
    const entry = parseHeader(block);
    const sink = await onEntry(entry);
    let left = entry.size;
    while (left > 0) {
      const part = await bytes.takeUpTo(left);
      left -= part.length;
      await sink.write(part);
    }
    await sink.end();
    await bytes.take((BLOCK - (entry.size % BLOCK)) % BLOCK);
  }
}

function parseHeader(block: Buffer): TarEntryHeader {
  const checksum = parseInt(textField(block, 148, 8), 8);
  const withSpaces = Buffer.from(block);
  withSpaces.write('        ', 148);
  if (withSpaces.reduce((sum, byte) => sum + byte, 0) !== checksum) throw new TarFormatError('A tar header has a wrong checksum');
  if (!REGULAR_FILE_FLAGS.has(block[156])) throw new TarFormatError('The tar can have only regular files');
  if (block[PREFIX_AT] !== 0) throw new TarFormatError('The tar has an entry with a long name');
  const size = parseInt(textField(block, 124, 12), 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new TarFormatError('A tar header has a wrong size');
  return { name: textField(block, 0, 100), size };
}

/** A text field of a header: it ends at the first NUL. Spaces around an octal number are removed. */
function textField(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf8').trim();
}

/** The bytes of a stream, taken in exact amounts */
class ByteQueue {
  private readonly parts: AsyncIterator<Uint8Array>;
  private buffered: Buffer[] = [];
  private length = 0;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.parts = source[Symbol.asyncIterator]();
  }

  /** Exactly `count` bytes */
  async take(count: number): Promise<Buffer> {
    while (this.length < count) await this.readMore();
    const all = Buffer.concat(this.buffered);
    this.buffered = [all.subarray(count)];
    this.length -= count;
    return all.subarray(0, count);
  }

  /** At least 1 byte and at most `count` bytes, without a copy of a large part */
  async takeUpTo(count: number): Promise<Buffer> {
    while (this.length === 0) await this.readMore();
    this.buffered = this.buffered.filter(buffer => buffer.length > 0);
    const first = this.buffered.shift()!;
    const part = first.subarray(0, count);
    if (first.length > count) this.buffered.unshift(first.subarray(count));
    this.length -= part.length;
    return part;
  }

  private async readMore(): Promise<void> {
    const { value, done } = await this.parts.next();
    if (done) throw new TarFormatError('The tar ends too soon');
    this.buffered.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    this.length += value.byteLength;
  }
}
