import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { allowLongUpload, limitRequestTime, WEB_SERVER_OPTIONS } from './webServerOptions.js';
import { UPDATE_TIME_LIMIT_MS } from './updates/timeLimits.js';

describe('WEB_SERVER_OPTIONS', () => {
  it('gives a slow upload of an update file the full update time, not the Node default of 5 minutes', () => {
    const server = createServer(WEB_SERVER_OPTIONS);

    expect(server.requestTimeout).toBe(UPDATE_TIME_LIMIT_MS);
  });

  it('still closes a connection that does not send its headers within one minute', () => {
    const server = createServer(WEB_SERVER_OPTIONS);

    expect(server.headersTimeout).toBe(60_000);
  });
});

describe('limitRequestTime', () => {
  /** A short limit, so the test does not wait 2 minutes */
  const LIMIT_MS = 150;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const app = new Hono()
      .post('/short', async c => c.text(`got ${await c.req.text()}`))
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
    server = serve({ fetch: app.fetch, port: 0, serverOptions: WEB_SERVER_OPTIONS }) as Server;
    limitRequestTime(server, LIMIT_MS);
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  /** All that the server sends on the socket, when the server or the client closes it */
  function replyOf(socket: Socket): Promise<string> {
    let reply = '';
    socket.on('data', chunk => { reply += chunk.toString(); });
    return new Promise(resolve => socket.on('close', () => resolve(reply)));
  }

  /** Send the headers and only the first 3 of 10 bytes of the body */
  async function startSlowUpload(path: string): Promise<{ socket: Socket; reply: Promise<string> }> {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const reply = replyOf(socket);
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc`);
    return { socket, reply };
  }

  it('closes a request that does not send its whole body within the limit', async () => {
    const { socket, reply } = await startSlowUpload('/short');
    const closedInTime = await Promise.race([reply.then(() => true), wait(LIMIT_MS * 10).then(() => false)]);

    expect(closedInTime).toBe(true);
    expect(await reply).not.toContain('got');
    socket.destroy();
  });

  it('gives more time to a route that allows a long upload', async () => {
    const { socket, reply } = await startSlowUpload('/long');
    await wait(LIMIT_MS * 3);

    expect(socket.destroyed).toBe(false);
    socket.write('defghij');
    expect(await reply).toContain('got abcdefghij');
  });

  it('does not close a reply that stays open longer than the limit after the request is in', async () => {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const reply = replyOf(socket);
    socket.write('GET /quiet HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');

    expect(await reply).toMatch(/first [\s\S]*last/);
  });
});
