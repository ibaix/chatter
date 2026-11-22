import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from '../logging/logger.js';

const log = createLogger('api');

/** Small helpers that every route file uses */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function notFound(c: Context, thing = 'Machine') {
  return c.json({ error: `${thing} not found` }, 404);
}

/** The reply when VictoriaMetrics cannot give the machine history. The log names the route (`logTag`) and the cause. */
export function historyUnavailable(c: Context, logTag: string, error: unknown) {
  log.error('Could not read the machine history', { route: logTag, error });
  return c.json({ error: 'The machine history is not available now. Try again later.' }, 503);
}

/** The reply text for an error that no route expected. The text of the error can show details of the server, so it stays in the log. */
export const UNEXPECTED_ERROR_TEXT = 'Chatter had an unexpected error. An admin can see the details in Settings > Diagnostics.';

/**
 * The log line of an error that a route did not catch, with its stack, the method and the path.
 * It has no query and no body, because they can hold names and passwords.
 */
function logUncaught(message: string, error: Error, c: Context) {
  log.error(message, { method: c.req.method, path: c.req.path, error });
}

/**
 * The reply for an error that the route did not catch.
 * An HTTPException (for example a body that is not JSON) keeps its status and text, and is not logged.
 * Each other error is logged, and the user gets a general text.
 */
export function errorReply(error: Error, c: Context) {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  logUncaught('A request failed with an unexpected error', error, c);
  return c.json({ error: UNEXPECTED_ERROR_TEXT }, 500);
}

/**
 * The reply for an error of a machine operation, for example a file download over FTP.
 * The user gets the text of the error, because the reply of the machine tells what went wrong (for example "550").
 */
export function machineErrorReply(error: Error, c: Context) {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  logUncaught('A machine operation failed', error, c);
  return c.json({ error: errorMessage(error) }, 500);
}
