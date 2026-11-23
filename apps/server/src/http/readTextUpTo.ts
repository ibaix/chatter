import { sizeText } from './sizeText.js';

/** A response body is larger than the limit of its reader. The reader stopped and cancelled the body. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The reply is larger than ${sizeText(maxBytes)}.`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * The body of the response as text. It reads the body in parts and stops at maxBytes, so a large or endless body does
 * not fill the memory of the Pi. A Content-Length larger than maxBytes stops it before it reads.
 * It decodes each part when it comes, so it keeps no copy of the raw bytes.
 * Throws BodyTooLargeError for a body larger than maxBytes, or the error of the read (for example an abort).
 */
export async function readTextUpTo(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}
