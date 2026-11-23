import { Hono } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.js';
import { matchesFilter, type LogFilter } from '../logging/LogBuffer.js';
import type { ServerLog } from '../logging/ServerLog.js';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { checkedJson, checkedQuery } from './checks.js';
import { streamSSEWithLog } from './streamReplies.js';

/** At most this many live log views at the same time, so a forgotten browser tab cannot use up the memory */
export const MAX_LOG_STREAMS = 3;
/** The lines that wait for one slow browser. More lines are dropped, and the browser gets the number that it lost. */
export const LOG_STREAM_QUEUE = 200;
/** A comment line this often keeps the connection open through a proxy */
const LOG_STREAM_HEARTBEAT_MS = 15_000;

const MAX_MACHINE_ID_LENGTH = 200;

const logFilterSchema = z.object({
  level: z.enum(LOG_LEVELS, { error: 'level must be debug, info, warn or error' }).optional(),
  machine: z.string().max(MAX_MACHINE_ID_LENGTH, 'machine is too long').optional(),
  since: z.iso.datetime({ error: 'since must be a time such as 2026-11-12T10:00:00Z' }).optional(),
});

const debugSchema = z.object({ on: z.boolean({ error: 'on must be true or false' }) });

function filterOf({ level, machine, since }: z.infer<typeof logFilterSchema>): LogFilter {
  return { level, machine: machine || undefined, since: since ? new Date(since) : undefined };
}

/** `chatter-log-2026-11-12T10-00-00Z.txt` */
export function downloadName(kind: string, time: Date, extension: string): string {
  return `chatter-${kind}-${time.toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')}.${extension}`;
}

/**
 * Settings > Diagnostics: download the last lines of the server log, see them live, and turn on the debug level.
 * The secrets are hidden in each line before it is kept (see logging/redact.ts). Only an admin can do this.
 */
export function logRoutes(serverLog: ServerLog) {
  const canManageChatter = requirePermission('manage-chatter');

  return new Hono<LoggedInEnv>()
    .get('/logs', canManageChatter, checkedQuery(logFilterSchema), c => {
      const text = serverLog.buffer.text(filterOf(c.req.valid('query')));
      return c.body(text, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadName('log', new Date(), 'txt')}"`,
        'Cache-Control': 'no-store',
      });
    })

    .get('/logs/stream', canManageChatter, checkedQuery(logFilterSchema), c => {
      if (serverLog.openStreams >= MAX_LOG_STREAMS) {
        return c.json({ error: `At most ${MAX_LOG_STREAMS} live logs can be open at the same time. Close one first.` }, 429);
      }
      serverLog.openStreams++;
      const filter = filterOf(c.req.valid('query'));
      return streamSSEWithLog(c, 'The live log', async stream => {
        try {
          await sendLines(stream, serverLog, filter);
        } finally {
          serverLog.openStreams--;
        }
      });
    })

    .get('/logs/debug', canManageChatter, c => c.json(serverLog.debug.state))

    .put('/logs/debug', canManageChatter, checkedJson(debugSchema), c => {
      const { username } = c.var.user;
      return c.json(c.req.valid('json').on ? serverLog.debug.turnOn(username) : serverLog.debug.turnOff(username));
    });
}

/** The last lines first, then each new line, until the browser goes away */
async function sendLines(stream: SSEStreamingApi, serverLog: ServerLog, filter: LogFilter): Promise<void> {
  const queue = serverLog.buffer.lines(filter).slice(-LOG_STREAM_QUEUE).map(entry => entry.text);
  let dropped = 0;
  let wake: (() => void) | null = null;
  const stop = serverLog.buffer.subscribe(entry => {
    if (!matchesFilter(entry, filter)) return;
    if (queue.length >= LOG_STREAM_QUEUE) dropped++;
    else queue.push(entry.text);
    wake?.();
  });
  stream.onAbort(() => {
    stop();
    wake?.();
  });
  try {
    while (!stream.aborted) {
      if (dropped > 0) {
        const count = dropped;
        dropped = 0;
        await stream.writeSSE({ event: 'dropped', data: String(count) });
      }
      const line = queue.shift();
      if (line !== undefined) {
        await stream.writeSSE({ event: 'line', data: line });
        continue;
      }
      const isWoken = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), LOG_STREAM_HEARTBEAT_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      wake = null;
      if (!isWoken && !stream.aborted) await stream.write(': keep-alive\n\n');
    }
  } finally {
    stop();
  }
}
