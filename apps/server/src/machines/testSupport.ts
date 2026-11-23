/** Test support for the readers of machine replies: a device that sends a reply with no end */
import type { Writable } from 'stream';

/** One part of an endless reply. It is about the size of one chunk that a socket gives to its reader. */
const ENDLESS_PART = 'X'.repeat(16 * 1024);

/**
 * Write `part` again and again, as fast as the reader takes it, until the connection closes.
 * Gives the number of bytes written when the connection closed.
 */
export function sendForever(stream: Writable, part = ENDLESS_PART): Promise<number> {
  let written = 0;
  return new Promise(resolve => {
    stream.once('close', () => resolve(written));
    stream.on('error', () => {});
    const writeMore = (): void => {
      while (!stream.destroyed && !stream.writableEnded) {
        written += part.length;
        if (!stream.write(part)) {
          stream.once('drain', writeMore);
          return;
        }
      }
    };
    writeMore();
  });
}
