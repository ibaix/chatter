import type { IncomingMessage, Server, ServerOptions } from 'node:http';
import { serve, type HttpBindings } from '@hono/node-server';
import { createMiddleware } from 'hono/factory';
import { UPDATE_TIME_LIMIT_MS } from './updates/timeLimits.js';
import { createLogger } from './logging/logger.js';

const log = createLogger('web-server');

/** A client must send all its request headers within this time. A browser sends them at once. */
const HEADERS_TIME_LIMIT_MS = 20_000;

/**
 * Node looks for connections that are over the header time limit this often. The Node default is 30 seconds,
 * so a connection that sent nothing could stay open for 50 seconds.
 */
const CONNECTIONS_CHECK_INTERVAL_MS = 5_000;

/**
 * The web server accepts at most this many connections at a time. Node closes each new connection above it at once.
 * Without a limit, one computer on the network can open connections until the process has no free file handles.
 * Then Chatter cannot open its database or its log, and it cannot connect to the machines.
 * The lowest file limit that Chatter can get is 1024 (Docker Desktop and Docker on the Pi give much more, and Node
 * raises its own limit to the hard limit). 256 keeps most of the 1024 free for the machines, the database and the logs.
 * A browser tab uses 1 to 6 connections, so 256 is enough for many users.
 */
const MAX_CONNECTIONS = 256;

/**
 * A client must send its whole request within this time, if the route does not allow a long upload.
 * A login or a form is a few kilobytes, so this is enough on a slow network.
 */
const REQUEST_TIME_LIMIT_MS = 2 * 60_000;

/**
 * The Node HTTP options for the web server.
 * Node has only one request time limit for the whole server. An update file of 600 MB on a slow network needs the
 * update time limit, so that is the Node limit. limitRequestTime() gives each other request a shorter limit.
 * The headers still have a short limit, so a client that connects and sends nothing is closed.
 * An upload that stops sending bytes is stopped by the idle limit of the update stream, not here.
 * There is no idle limit on the socket, because the live machine events (SSE) can be quiet for a long time.
 */
export const WEB_SERVER_OPTIONS: ServerOptions = {
  requestTimeout: UPDATE_TIME_LIMIT_MS,
  headersTimeout: HEADERS_TIME_LIMIT_MS,
  connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS,
};

/** The reply text when a request takes too long */
const REQUEST_TOO_SLOW_TEXT = 'The request took too long. Try again.';

/** The requests that a route allowed to take the Node time limit */
const longRequests = new WeakSet<IncomingMessage>();

/**
 * Lets a large upload take the full Node time limit, not REQUEST_TIME_LIMIT_MS.
 * Put it after the login and the role checks, so a client with no login cannot hold a connection for long.
 */
export const allowLongUpload = createMiddleware(async (c, next) => {
  const { incoming } = (c.env ?? {}) as Partial<HttpBindings>;
  if (incoming) longRequests.add(incoming);
  return next();
});

/**
 * True when a route allowed this request to take the full Node time limit.
 * Only the route tests use this. They check that each large upload route marks the request after the login and the role check.
 * A test on a real socket cannot see this: a refused login, a refused role or an unknown machine gets its reply before
 * the route reads the body, and the end of the reply stops the time limit. The tests of startWebServer test the limit itself.
 */
export const hasLongTimeLimit = (incoming: IncomingMessage): boolean => longRequests.has(incoming);

/**
 * Closes a request that did not send its whole body within the limit, unless its route allowed a long upload.
 * The client gets a 408 reply first, if the route did not start its reply.
 * Without this, a client with no login could hold each connection open for the full update time limit.
 * A reply can stay open longer (the live machine events do), because the limit is only on the request.
 */
function limitRequestTime(server: Server, limitMs: number): void {
  server.on('request', (req: IncomingMessage, res) => {
    const timer = setTimeout(() => {
      if (req.complete || longRequests.has(req)) return;
      // The query and the body can hold names and passwords, so they are not in the log
      log.warn('A request took too long. Chatter closed it', { method: req.method, path: req.url?.split('?')[0] });
      if (res.headersSent) {
        req.socket.destroy();
        return;
      }
      // This reply does not go through the app, so the security headers of the app are not on it
      res.writeHead(408, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end(JSON.stringify({ error: REQUEST_TOO_SLOW_TEXT }), () => req.socket.destroy());
    }, limitMs);
    timer.unref();
    res.once('close', () => clearTimeout(timer));
  });
}

/** The app that the web server serves */
type WebApp = Pick<Parameters<typeof serve>[0], 'fetch'>;

export interface WebServerStart {
  /** Called when the server listens */
  onListening?: () => void;
  /** Only a test gives a shorter limit, so that it does not wait 2 minutes */
  requestTimeLimitMs?: number;
  /** Only a test gives a smaller limit */
  maxConnections?: number;
  /** Only a test changes these Node options, for example to give a shorter header time limit */
  serverOptions?: ServerOptions;
}

/**
 * Starts the web server with WEB_SERVER_OPTIONS, the connection limit and the request time limit.
 * serve() makes a plain HTTP/1 server, because no HTTP/2 option is given.
 */
export function startWebServer(app: WebApp, port: number, {
  onListening, requestTimeLimitMs = REQUEST_TIME_LIMIT_MS, maxConnections = MAX_CONNECTIONS, serverOptions,
}: WebServerStart = {}): Server {
  const options = { ...WEB_SERVER_OPTIONS, ...serverOptions };
  const server = serve({ fetch: app.fetch, port, serverOptions: options }, () => onListening?.()) as Server;
  server.maxConnections = maxConnections;
  limitRequestTime(server, requestTimeLimitMs);
  return server;
}
