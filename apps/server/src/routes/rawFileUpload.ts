import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

const RAW_FILE_TYPE = 'application/octet-stream';
const WHOLE_NUMBER = /^\d+$/;

/**
 * The checks of a large file that the browser sends as the raw body, not as a form.
 * `fileName` names the file in the error texts, for example "the update file".
 *
 * bodyLimit reads a body with no length into memory to count it. The Pi has only 512 MB.
 * So the request must give its length first, and bodyLimit then checks only that number.
 */
export function rawFileUpload(fileName: string, maxBytes: number, limitMessage: string): MiddlewareHandler[] {
  const requireRawFile = createMiddleware(async (c, next) => {
    const mediaType = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== RAW_FILE_TYPE) return c.json({ error: `Send ${fileName} as ${RAW_FILE_TYPE}` }, 415);
    return next();
  });
  const requireLengthFirst = createMiddleware(async (c, next) => {
    const length = c.req.header('Content-Length') ?? '';
    if (!WHOLE_NUMBER.test(length) || c.req.header('Transfer-Encoding') !== undefined) {
      return c.json({ error: `Send the length of ${fileName} (Content-Length)` }, 411);
    }
    return next();
  });
  return [requireRawFile, requireLengthFirst, bodyLimit({ maxSize: maxBytes, onError: c => c.json({ error: limitMessage }, 413) })];
}
