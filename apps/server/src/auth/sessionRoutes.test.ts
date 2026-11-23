import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { HardwarePoller } from '../polling/poller.js';
import { noHistory } from '../recording/testSupport.js';
import { SESSION_COOKIE } from './authRoutes.js';
import { SEEN_INTERVAL_MS, SESSION_IDLE_MS } from './sessionStore.js';
import { KEEP_ALIVE_MS } from '../realtime/machineEvents.js';
import { authParts, loggedInAuth, TEST_LOGIN } from './testSupport.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36';

interface SessionsReport {
  sessions: { device: string; address: string; lastSeenAt: string; isThisBrowser: boolean }[];
}

describe('session routes', () => {
  let app: ReturnType<typeof createApp>;
  let setupCookie: string;

  beforeEach(async () => {
    const { auth, accounts, cookie } = await loggedInAuth();
    setupCookie = cookie;
    app = createApp({ poller: new HardwarePoller(new Database(':memory:')), auth, accounts, history: noHistory() });
  });

  /** Log in from another browser, and give its cookie */
  async function logInFromChrome(): Promise<string> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': MAC_CHROME },
      body: JSON.stringify(TEST_LOGIN),
    });
    return (res.headers.get('Set-Cookie') ?? '').split(';')[0];
  }

  const withCookie = (cookie: string, method = 'GET') => ({ method, headers: { Cookie: cookie } });

  it('needs a browser login', async () => {
    expect((await app.request('/api/auth/sessions')).status).toBe(401);
    expect((await app.request('/api/auth/sessions/log-out-others', { method: 'POST' })).status).toBe(401);
  });

  it('lists each browser, and marks this one', async () => {
    const chromeCookie = await logInFromChrome();
    expect(chromeCookie).toContain(`${SESSION_COOKIE}=`);

    const report = (await (await app.request('/api/auth/sessions', withCookie(chromeCookie))).json()) as SessionsReport;
    expect(report.sessions).toHaveLength(2);
    expect(report.sessions.find(session => session.isThisBrowser)?.device).toBe('Chrome on Mac');
  });

  it('logs out every other browser', async () => {
    const chromeCookie = await logInFromChrome();

    const res = await app.request('/api/auth/sessions/log-out-others', withCookie(chromeCookie, 'POST'));

    expect(((await res.json()) as SessionsReport).sessions).toEqual([expect.objectContaining({ isThisBrowser: true })]);
    expect((await app.request('/api/machines', withCookie(setupCookie))).status).toBe(401);
    expect((await app.request('/api/machines', withCookie(chromeCookie))).status).toBe(200);
  });

  describe('with a clock', () => {
    let now: number;
    let clockedApp: ReturnType<typeof createApp>;
    let cookie: string;

    beforeEach(async () => {
      now = Date.parse('2026-11-09T10:00:00Z');
      const db = new Database(':memory:');
      const { auth, accounts } = authParts(db, () => now);
      const token = await auth.setUp(TEST_LOGIN, { userAgent: MAC_CHROME, address: '127.0.0.1' });
      clockedApp = createApp({ poller: new HardwarePoller(db), auth, accounts, history: noHistory() });
      cookie = `${SESSION_COOKIE}=${token}`;
    });

    const lastSeenAt = async () =>
      ((await (await clockedApp.request('/api/auth/sessions', withCookie(cookie))).json()) as SessionsReport).sessions[0].lastSeenAt;

    it('saves when a browser was last used', async () => {
      now += SEEN_INTERVAL_MS;
      await clockedApp.request('/api/machines', withCookie(cookie));

      expect(await lastSeenAt()).toBe(new Date(now).toISOString());
    });

    it('ends a login that is not used for 14 days', async () => {
      now += SESSION_IDLE_MS;
      expect((await clockedApp.request('/api/machines', withCookie(cookie))).status).toBe(200);

      now += SESSION_IDLE_MS + SEEN_INTERVAL_MS + 1;
      expect((await clockedApp.request('/api/machines', withCookie(cookie))).status).toBe(401);
    });

    it('keeps the login of a visible page, which tells that it is in use, for longer than 14 days', async () => {
      const inUse = () => clockedApp.request('/api/auth/sessions/in-use', withCookie(cookie, 'POST'));
      for (let day = 0; day < 20; day++) {
        now += DAY_MS;
        expect((await inUse()).status).toBe(204);
      }

      expect(await lastSeenAt()).toBe(new Date(now).toISOString());
      expect((await clockedApp.request('/api/machines', withCookie(cookie))).status).toBe(200);
    });

    it('does not count an open live stream as a use of the login', async () => {
      vi.useFakeTimers();
      try {
        const reader = (await clockedApp.request('/api/events', withCookie(cookie))).body!.getReader();
        await reader.read();
        const openedAt = await lastSeenAt();

        for (let i = 0; i < 3; i++) {
          now += SEEN_INTERVAL_MS;
          await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
        }

        expect(await lastSeenAt()).toBe(openedAt);
        await reader.cancel();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('tells that a page is in use only for a browser that is logged in', async () => {
    expect((await app.request('/api/auth/sessions/in-use', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/auth/sessions/in-use', withCookie(setupCookie, 'POST'))).status).toBe(204);
  });
});
