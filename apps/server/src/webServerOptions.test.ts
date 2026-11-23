import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { Hono } from 'hono';
import { allowLongUpload, startWebServer, WEB_SERVER_OPTIONS } from './webServerOptions.js';
import { UPDATE_TIME_LIMIT_MS } from './updates/timeLimits.js';
import { captureLog } from './logging/testSupport.js';

/** All that the server sends on the socket, when the server or the client closes it */
function replyOf(socket: Socket): Promise<string> {
  let reply = '';
  socket.on('data', chunk => { reply += chunk.toString(); });
  return new Promise(resolve => socket.on('close', () => resolve(reply)));
}

describe('WEB_SERVER_OPTIONS', () => {
  it('gives a slow upload of an update file the full update time, not the Node default of 5 minutes', () => {
    const server = createServer(WEB_SERVER_OPTIONS);

    expect(server.requestTimeout).toBe(UPDATE_TIME_LIMIT_MS);
  });

  it('closes a connection that does not send its headers within 20 seconds', () => {
    const server = createServer(WEB_SERVER_OPTIONS);

    expect(server.headersTimeout).toBe(20_000);
  });

  it('checks the header time limit each 5 seconds, not each 30 seconds as the Node default', () => {
    expect(WEB_SERVER_OPTIONS.connectionsCheckingInterval).toBe(5_000);
  });
});

describe('the address of startWebServer', () => {
  let server: Server;

  afterEach(() => {
    server.close();
  });

  async function addressOf(settings: Parameters<typeof startWebServer>[2]): Promise<string> {
    server = startWebServer(new Hono().get('/', c => c.text('hello')), 0, settings);
    await once(server, 'listening');
    return (server.address() as AddressInfo).address;
  }

  it('listens on all addresses when no hostname is given, as Chatter does on the shop network', async () => {
    expect(['::', '0.0.0.0']).toContain(await addressOf({}));
  });

  it('listens only on the given hostname', async () => {
    expect(await addressOf({ hostname: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('the connection limits of startWebServer', () => {
  let server: Server;

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  async function start(settings: Parameters<typeof startWebServer>[2]): Promise<number> {
    server = startWebServer(new Hono().get('/', c => c.text('hello')), 0, { hostname: '127.0.0.1', ...settings });
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }

  async function open(port: number): Promise<{ socket: Socket; reply: Promise<string> }> {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    return { socket, reply: replyOf(socket) };
  }

  it('accepts at most 256 connections at a time', async () => {
    await start({});

    expect(server.maxConnections).toBe(256);
  });

  it('closes a new connection at once when the limit is full', async () => {
    const port = await start({ maxConnections: 2 });
    const first = await open(port);
    const second = await open(port);
    await wait(50);

    const third = await open(port);
    const closedAtOnce = await Promise.race([third.reply.then(() => true), wait(500).then(() => false)]);

    expect(closedAtOnce).toBe(true);
    expect(first.socket.destroyed).toBe(false);
    expect(second.socket.destroyed).toBe(false);
    first.socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(await first.reply).toContain('hello');
  });

  it('closes a connection that sends no headers after the header time limit', async () => {
    const port = await start({ serverOptions: { headersTimeout: 200, connectionsCheckingInterval: 50 } });
    const { socket, reply } = await open(port);

    const closedInTime = await Promise.race([reply.then(() => true), wait(2_000).then(() => false)]);

    expect(closedInTime).toBe(true);
    socket.destroy();
  });

  it('keeps a connection open within the header time limit', async () => {
    const port = await start({ serverOptions: { headersTimeout: 5_000, connectionsCheckingInterval: 50 } });
    const { socket, reply } = await open(port);
    await wait(300);

    expect(socket.destroyed).toBe(false);
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(await reply).toContain('hello');
  });
});

describe('startWebServer', () => {
  /** A short limit, so the test does not wait 2 minutes */
  const LIMIT_MS = 150;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const app = new Hono()
      .post('/short', async c => c.text(`got ${await c.req.text()}`))
      // Like a refused login: the reply goes before the route reads the body
      .post('/early', c => c.json({ error: 'Log in first' }, 401))
      .post('/long', allowLongUpload, async c => c.text(`got ${await c.req.text()}`))
      // Like the live machine events: the request has no body, and the reply stays open longer than the limit
      .get('/quiet', () => new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('first '));
          await wait(LIMIT_MS * 3);
          controller.enqueue(new TextEncoder().encode('last'));
          controller.close();
        },
      })));
    server = startWebServer(app, 0, { requestTimeLimitMs: LIMIT_MS, hostname: '127.0.0.1' });
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  /** Send the headers and only the first 3 of 10 bytes of the body */
  async function startSlowUpload(path: string): Promise<{ socket: Socket; reply: Promise<string> }> {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const reply = replyOf(socket);
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc`);
    return { socket, reply };
  }

  it('uses the web server options', () => {
    expect(server.requestTimeout).toBe(WEB_SERVER_OPTIONS.requestTimeout);
    expect(server.headersTimeout).toBe(WEB_SERVER_OPTIONS.headersTimeout);
  });

  it('closes a request that does not send its whole body within the limit, with a 408 reply', async () => {
    const { socket, reply } = await startSlowUpload('/short');
    const closedInTime = await Promise.race([reply.then(() => true), wait(LIMIT_MS * 10).then(() => false)]);

    expect(closedInTime).toBe(true);
    const text = await reply;
    expect(text).toMatch(/^HTTP\/1\.1 408 /);
    expect(text).toContain('{"error":"The request took too long. Try again."}');
    expect(text).not.toContain('got');
    socket.destroy();
  });

  it('tells the browser not to guess the type of the 408 reply, because the security headers of the app are not on it', async () => {
    const { socket, reply } = await startSlowUpload('/short');
    expect((await reply).toLowerCase()).toContain('\r\nx-content-type-options: nosniff\r\n');
    socket.destroy();
  });

  it('logs one warning with the method and the path of the closed request, but not its query or its body', async () => {
    const log = captureLog();
    try {
      const { reply } = await startSlowUpload('/short?token=secret-token');
      await reply;
      await wait(LIMIT_MS);

      const warnings = log.lines.filter(line => line.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].text).toContain('web-server');
      expect(warnings[0].text).toContain('POST');
      expect(warnings[0].text).toContain('/short');
      expect(warnings[0].text).not.toContain('secret-token');
      expect(warnings[0].text).not.toContain('abc');
    } finally {
      log.restore();
    }
  });

  it('gives more time to a route that allows a long upload', async () => {
    const { socket, reply } = await startSlowUpload('/long');
    await wait(LIMIT_MS * 3);

    expect(socket.destroyed).toBe(false);
    socket.write('defghij');
    expect(await reply).toContain('got abcdefghij');
  });

  it('stops the time limit when the reply ends, though the body is not all in', async () => {
    const log = captureLog();
    try {
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      const reply = replyOf(socket);
      // Node keeps the connection open for some seconds after the reply, and it reads the rest of the body
      socket.write('POST /early HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nabc');
      await wait(LIMIT_MS * 3);

      expect(socket.destroyed).toBe(false);
      expect(log.lines.filter(line => line.level === 'warn')).toEqual([]);
      socket.destroy();
      expect(await reply).toMatch(/^HTTP\/1\.1 401 /);
    } finally {
      log.restore();
    }
  });

  it('does not close a reply that stays open longer than the limit after the request is in', async () => {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const reply = replyOf(socket);
    socket.write('GET /quiet HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');

    expect(await reply).toMatch(/first [\s\S]*last/);
  });
});

describe('startWebServer with the default request time limit', () => {
  let server: Server;

  afterEach(() => {
    vi.useRealTimers();
    server.closeAllConnections();
    server.close();
  });

  it('gives a request 2 minutes to send its whole body', async () => {
    // Only the timers of the time limit are fake. The sockets stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = startWebServer(new Hono().post('/short', async c => c.text(await c.req.text())), 0, { hostname: '127.0.0.1' });
    await once(server, 'listening');
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    const reply = replyOf(socket);
    const requestIn = once(server, 'request');
    socket.write('POST /short HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nabc');
    await requestIn;

    await vi.advanceTimersByTimeAsync(119_000);
    await wait(50);
    expect(socket.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await reply).toMatch(/^HTTP\/1\.1 408 /);
  });
});
