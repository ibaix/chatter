import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createMiddleware } from 'hono/factory';
import { API_PREFIX } from './app.js';

const isApiPath = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
/** A file address, such as /assets/index-1a2b.js, ends in a file extension. A page address does not. */
const isFilePath = (path: string) => /\.[^/]+$/.test(path);

/**
 * Vite puts a hash in the name of each file in assets/, so a new build gives new names, and the browser can keep these files.
 * The other files (index.html, theme-start.js, the icons and the manifest) keep their names after an update.
 * no-cache makes the browser ask the server for them each time, so it does not use an old copy after an update.
 */
const noCacheUnlessHashed = createMiddleware(async (c, next) => {
  await next();
  const path = c.req.path;
  if (c.res.ok && !isApiPath(path) && !path.startsWith('/assets/')) c.res.headers.set('Cache-Control', 'no-cache');
});

/**
 * Serve the built web app (apps/web/dist) from the same server as the API.
 * Any other page address gets index.html, so the web app's own router can show that page.
 * A missing file and an unknown /api address get a 404 reply.
 * (After an update, an old tab may ask for an old file. It must get 404, not the page as JavaScript.)
 */
export function webAppRoutes(webDir: string) {
  const serveIndexPage = serveStatic({ root: webDir, path: 'index.html' });
  return new Hono()
    .use('*', noCacheUnlessHashed)
    .use('*', serveStatic({ root: webDir }))
    .get('*', (c, next) => {
      const path = c.req.path;
      return isApiPath(path) || isFilePath(path) ? next() : serveIndexPage(c, next);
    });
}
