import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createApp } from './app.js';
import { HardwarePoller } from './polling/poller.js';
import { noHistory } from './recording/testSupport.js';
import { webAppRoutes } from './webApp.js';
import { loggedInAuth } from './auth/testSupport.js';
import { captureLog } from './logging/testSupport.js';

/** A database that has no machines */
const emptyDb = {
  prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
} as unknown as Database.Database;

describe('webAppRoutes', () => {
  let webDir: string;
  let app: ReturnType<typeof createApp>;
  let loggedIn: RequestInit;
  let poller: HardwarePoller;

  beforeAll(async () => {
    webDir = mkdtempSync(join(tmpdir(), 'chatterbox-web-'));
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    const { auth, accounts, cookie } = await loggedInAuth();
    loggedIn = { headers: { Cookie: cookie } };
    poller = new HardwarePoller(emptyDb);
    app = createApp({ poller, auth, accounts, history: noHistory() });
    app.route('/', webAppRoutes(webDir));
  });

  afterAll(() => rmSync(webDir, { recursive: true, force: true }));

  it('serves the index page at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('serves a built file', async () => {
    const res = await app.request('/assets/app.js');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('serves the index page for a page of the web app', async () => {
    const res = await app.request('/machine/brother_1');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('gives 404 for a missing file, not the index page', async () => {
    const res = await app.request('/assets/index-old.js');
    expect(res.status).toBe(404);
  });

  it('still serves the API', async () => {
    const res = await app.request('/api/machines', loggedIn);
    expect(await res.json()).toEqual([]);
  });

  it('gives a JSON 404 for an unknown API address', async () => {
    const res = await app.request('/api/nothing-here', loggedIn);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  describe('security headers', () => {
    /** The policy as a map from each directive to its sources */
    function policyOf(res: Response): Record<string, string> {
      const header = res.headers.get('Content-Security-Policy') ?? '';
      return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources.join(' ')];
      }));
    }

    function expectSecurityHeaders(res: Response) {
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
      // Chatter often runs on plain HTTP on a LAN. HSTS there can lock the users out.
      expect(res.headers.has('Strict-Transport-Security')).toBe(false);
      expect(policyOf(res)).toEqual({
        'default-src': "'self'",
        'script-src': "'self'",
        // Some UI parts add <style> elements when they run
        'style-src': "'self' 'unsafe-inline'",
        'img-src': "'self' data: blob:",
        // The built CSS has some fonts in data: addresses
        'font-src': "'self' data:",
        'connect-src': "'self'",
        'object-src': "'none'",
        'base-uri': "'self'",
        'form-action': "'self'",
        'frame-ancestors': "'none'",
      });
    }

    it('are on the index page', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);
    });

    it('are on a page of the web app and on a built file', async () => {
      expectSecurityHeaders(await app.request('/machine/brother_1'));
      expectSecurityHeaders(await app.request('/assets/app.js'));
    });

    it('are on an API reply that needs no login', async () => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);
    });

    it('are on a 404 reply', async () => {
      expectSecurityHeaders(await app.request('/api/nothing-here', loggedIn));
      expectSecurityHeaders(await app.request('/assets/index-old.js'));
    });

    it('are on a reply that refuses a request with no login', async () => {
      const res = await app.request('/api/machines');
      expect(res.status).toBe(401);
      expectSecurityHeaders(res);
    });

    it('are on a reply that refuses a body that is too large', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      expectSecurityHeaders(res);
    });

    it('are on the reply of the error handler', async () => {
      const log = captureLog();
      const getStatus = vi.spyOn(poller, 'getStatus').mockImplementation(() => {
        throw new Error('broken');
      });
      try {
        const res = await app.request('/api/status', loggedIn);
        expect(res.status).toBe(500);
        expectSecurityHeaders(res);
      } finally {
        getStatus.mockRestore();
        log.restore();
      }
    });

    it('do not stop a file download', async () => {
      const res = await app.request('/api/logs', loggedIn);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="/);
      expectSecurityHeaders(res);
    });

    it('do not stop the live events', async () => {
      const res = await app.request('/api/events', loggedIn);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');
      expectSecurityHeaders(res);
      await res.body?.cancel();
    });
  });
});
