import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { startWebServer } from '../webServerOptions.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { STREAM_STOPPED_TEXT, streamSSEWithLog, streamWithoutErrorText } from './streamReplies.js';

/** The error of a file that was deleted while Chatter sent it. Its text has a path on the server. */
const LOCAL_ERROR_TEXT = "ENOENT: no such file or directory, open '/app/data/history-backup/part-1.jsonl.gz'";

/** A stream that sends `firstParts`, then fails */
function failingStream(firstParts: string[]): ReadableStream<Uint8Array> {
  const parts = [...firstParts];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.error(new Error(LOCAL_ERROR_TEXT));
      else controller.enqueue(new TextEncoder().encode(part));
    },
  });
}

/** A whole chunked reply ends with a chunk of size 0 */
const LAST_CHUNK = '\r\n0\r\n\r\n';

const errorLines = (log: CapturedLog) => log.lines.filter(line => line.level === 'error');

describe('streamed replies on a real web server', () => {
  let server: Server;
  let log: CapturedLog;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = captureLog();
    // @hono/node-server writes stream errors with console.error, outside the Chatter log
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    log.restore();
    consoleError.mockRestore();
    server.closeAllConnections();
    server.close();
  });

  async function start(app: Hono): Promise<number> {
    server = startWebServer(app, 0);
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }

  /** All the bytes that the server sends, until the reply ends or the server closes the connection */
  async function rawReply(port: number, path: string): Promise<string> {
    const socket = connect(port, '127.0.0.1');
    let reply = '';
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    await new Promise<void>(resolve => {
      socket.on('data', chunk => {
        reply += chunk.toString();
        // The event stream asks for keep-alive, so its reply ends with the last chunk and not with a close
        if (reply.endsWith(LAST_CHUNK)) resolve();
      });
      socket.on('close', () => resolve());
    });
    socket.destroy();
    return reply;
  }

  describe('streamWithoutErrorText', () => {
    const app = () => new Hono()
      .get('/download/:parts', c => {
        const parts = Number(c.req.param('parts'));
        const stream = failingStream(Array.from({ length: parts }, (_, index) => `part ${index};`));
        return c.body(streamWithoutErrorText(c, stream, 'The test download'), 200, { 'Content-Type': 'application/gzip' });
      });

    it.each([0, 1, 5])('sends no error text and no path when the stream fails after %i parts, and logs one error', async parts => {
      const port = await start(app());

      const reply = await rawReply(port, `/download/${parts}`);

      expect(reply).not.toContain('ENOENT');
      expect(reply).not.toContain('/app/data');
      expect(reply).not.toContain('Error');
      expect(errorLines(log)).toHaveLength(1);
      expect(log.text('error')).toContain(LOCAL_ERROR_TEXT);
      expect(log.text('error')).toContain('path=/download/');
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('stops the reply, so the browser does not keep a part of the file as a whole file', async () => {
      const port = await start(app());

      const reply = await rawReply(port, '/download/5');

      expect(reply).toMatch(/^HTTP\/1\.1 200/);
      expect(reply.endsWith(LAST_CHUNK)).toBe(false);
    });

    it('logs no error and stops the source when the browser cancels the download in the middle', async () => {
      const cancelSource = vi.fn();
      let sentParts = 0;
      // Sends one part, then waits for a slow machine that does not reply
      const slowSource = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sentParts++ === 0) controller.enqueue(new TextEncoder().encode('part 0;'));
          else return new Promise<void>(() => {});
        },
        cancel: cancelSource,
      });
      const port = await start(new Hono().get('/slow', c => c.body(streamWithoutErrorText(c, slowSource, 'The test download'))));

      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
      let reply = '';
      await new Promise<void>(resolve => socket.on('data', chunk => {
        reply += chunk.toString();
        if (reply.includes('part 0;')) resolve();
      }));
      // The browser cancels the download
      socket.destroy();
      await vi.waitFor(() => expect(cancelSource).toHaveBeenCalled());
      // The read that waited ends after the cancel. Give it time to log.
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(errorLines(log)).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('sends a stream with no error as it is', async () => {
      const port = await start(new Hono().get('/ok', c => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('all of the file'));
            controller.close();
          },
        });
        return c.body(streamWithoutErrorText(c, stream, 'The test download'));
      }));

      const reply = await rawReply(port, '/ok');

      expect(reply).toMatch(/^HTTP\/1\.1 200/);
      expect(reply).toContain('all of the file');
      expect(log.lines).toEqual([]);
    });
  });

  describe('streamSSEWithLog', () => {
    it('logs an error of the event stream, sends no error text, and closes the stream', async () => {
      const port = await start(new Hono().get('/events', c => streamSSEWithLog(c, 'The test events', async stream => {
        await stream.writeSSE({ event: 'list', data: '[]' });
        throw new Error(LOCAL_ERROR_TEXT);
      })));

      // rawReply ends only when the server closes the stream
      const reply = await rawReply(port, '/events');

      expect(reply).toContain('event: list');
      expect(reply.endsWith(LAST_CHUNK)).toBe(true);
      expect(reply).not.toContain('event: error');
      expect(reply).not.toContain('ENOENT');
      expect(errorLines(log)).toHaveLength(1);
      expect(log.text('error')).toContain(LOCAL_ERROR_TEXT);
      expect(log.text('error')).toContain('path=/events');
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('logs a failure value that is not an Error', async () => {
      const port = await start(new Hono().get('/events', c => streamSSEWithLog(c, 'The test events', async () => {
        throw 'plain text';
      })));

      await rawReply(port, '/events');

      expect(errorLines(log)).toHaveLength(1);
      expect(log.text('error')).toContain('plain text');
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});

describe('streamWithoutErrorText backpressure', () => {
  it('reads the source only when the browser takes the bytes, so a large file does not fill the memory', async () => {
    let pulls = 0;
    // A file of 100 parts. Each pull reads one part from the disk or the machine.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) controller.close();
        else controller.enqueue(new TextEncoder().encode(`part ${pulls};`));
      },
    });
    const app = new Hono().get('/download', c => {
      // The browser does not read the reply
      streamWithoutErrorText(c, source, 'The test download');
      return c.text('started');
    });

    await app.request('/download');
    await new Promise(resolve => setTimeout(resolve, 50));

    // One part for the queue of the source, and one for the queue of the download
    expect(pulls).toBeLessThanOrEqual(2);
  });
});

describe('streamWithoutErrorText without a Node response', () => {
  it('fails the stream with a general text, so a test client sees no path', async () => {
    const log = captureLog();
    const app = new Hono().get('/download', c => c.body(streamWithoutErrorText(c, failingStream(['part;']), 'The test download')));

    const res = await app.request('/download');
    const failure = await res.arrayBuffer().then(() => null, (error: Error) => error);
    log.restore();

    expect(failure?.message).toBe(STREAM_STOPPED_TEXT);
    expect(log.lines.filter(line => line.level === 'error')).toHaveLength(1);
  });
});
