import type { IncomingMessage, Server, ServerOptions } from 'node:http';
import { serve, type HttpBindings } from '@hono/node-server';
import { createMiddleware } from 'hono/factory';
import { UPDATE_TIME_LIMIT_MS } from './updates/timeLimits.js';

/** A client must send all its request headers within this time */
const HEADERS_TIME_LIMIT_MS = 60_000;

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
};

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

/** True when a route allowed this request to take the full Node time limit */
export const hasLongTimeLimit = (incoming: IncomingMessage): boolean => longRequests.has(incoming);

/**
 * Closes a request that did not send its whole body within the limit, unless its route allowed a long upload.
 * Without this, a client with no login could hold each connection open for the full update time limit.
 * A reply can stay open longer (the live machine events do), because the limit is only on the request.
 */
function limitRequestTime(server: Server, limitMs: number): void {
  server.on('request', (req: IncomingMessage, res) => {
    const timer = setTimeout(() => {
      if (!req.complete && !longRequests.has(req)) req.socket.destroy();
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
}

/**
 * Starts the web server with WEB_SERVER_OPTIONS and the request time limit.
 * serve() makes a plain HTTP/1 server, because no HTTP/2 option is given.
 */
export function startWebServer(app: WebApp, port: number, { onListening, requestTimeLimitMs = REQUEST_TIME_LIMIT_MS }: WebServerStart = {}): Server {
  const server = serve({ fetch: app.fetch, port, serverOptions: WEB_SERVER_OPTIONS }, () => onListening?.()) as Server;
  limitRequestTime(server, requestTimeLimitMs);
  return server;
}
