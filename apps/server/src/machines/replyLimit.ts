import type { Logger } from '../logging/logger.js';

const BYTES_IN_KB = 1024;
const BYTES_IN_MB = 1024 * 1024;

/** "16 MB", "64 KB", or the number of bytes for a smaller size */
function sizeText(bytes: number): string {
  if (bytes >= BYTES_IN_MB && bytes % BYTES_IN_MB === 0) return `${bytes / BYTES_IN_MB} MB`;
  if (bytes >= BYTES_IN_KB && bytes % BYTES_IN_KB === 0) return `${bytes / BYTES_IN_KB} KB`;
  return `${bytes} bytes`;
}

/**
 * A reply is larger than the limit of its reader. The reader stops, so a broken control, or another device at the
 * address of a machine, cannot fill the memory of the Pi with an endless reply.
 */
export class ReplyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The machine sent a reply larger than ${sizeText(maxBytes)}. Chatter stopped reading it and closed the connection.`);
    this.name = 'ReplyTooLargeError';
  }
}

/** Write one warning with the machine and the limit, and give the error */
export function warnReplyTooLarge(log: Logger, machineId: string, error: ReplyTooLargeError): ReplyTooLargeError {
  log.warn('The machine sent a reply larger than the limit. Chatter closed the connection.', {
    machine: machineId,
    limitBytes: error.maxBytes,
  });
  return error;
}

/**
 * The body of the response as text. It reads the body in parts and stops at maxBytes, so a large or endless body does
 * not fill the memory of the Pi. A Content-Length larger than maxBytes stops it before it reads.
 * Throws ReplyTooLargeError for a body larger than maxBytes, or the error of the read (for example an abort).
 */
export async function readTextUpTo(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ReplyTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new ReplyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
