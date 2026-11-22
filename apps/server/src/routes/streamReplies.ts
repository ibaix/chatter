import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { createLogger } from '../logging/logger.js';

const log = createLogger('api');

/**
 * Streamed replies (downloads and live events) start before their last bytes are ready. So an error in the middle
 * does not go through errorReply. @hono/node-server writes such an error with console.error, and hono's streamSSE
 * sends the error text to the browser when it has an onError. The helpers here log the error through createLogger
 * (so Settings > Diagnostics shows it, with the secrets hidden) and never send its text, which can hold a path.
 * @hono/node-server has no option to replace its own handler, so these helpers catch the error before it gets there.
 */

/** The error that a client in the same process (a test) gets when a download stops. A browser gets a closed connection. */
export const STREAM_STOPPED_TEXT = 'The download stopped because of an error in Chatter';

/** The method and the path of the request. The query can hold names, so it is not in the log. */
const requestOf = (c: Context) => ({ method: c.req.method, path: c.req.path });

/**
 * The body of a download that logs an error in the middle and then stops the reply.
 * The connection closes before the last chunk, so the browser marks the download as failed
 * and does not keep a part of the file as the whole file.
 * `what` names the download in the log, for example "The history backup download".
 */
export function streamWithoutErrorText(c: Context, source: ReadableStream<Uint8Array>, what: string): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  // The browser cancelled the download. Then the wrapper is closed already, and a read that waited ends with done.
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        log.error(`${what} stopped with an error`, { ...requestOf(c), error });
        const { outgoing } = (c.env ?? {}) as Partial<HttpBindings>;
        if (!outgoing) {
          controller.error(new Error(STREAM_STOPPED_TEXT));
          return;
        }
        outgoing.destroy();
        controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      log.debug(`${what} stopped because the browser cancelled it`, requestOf(c));
      return reader.cancel(reason);
    },
  });
}

/**
 * streamSSE, but an error of `run` goes to the log and not to the browser. Then the stream closes,
 * and the browser connects again (EventSource does this by itself).
 * `what` names the stream in the log, for example "The live machine events".
 */
export function streamSSEWithLog(c: Context, what: string, run: (stream: SSEStreamingApi) => Promise<void>): Response {
  return streamSSE(c, async stream => {
    try {
      await run(stream);
    } catch (error) {
      log.error(`${what} stopped with an error`, { ...requestOf(c), ...(error instanceof Error ? { error } : { reason: String(error) }) });
    }
    // streamSSE closes the stream when this function returns
  });
}
