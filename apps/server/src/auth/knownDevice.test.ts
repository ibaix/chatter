import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { HardwarePoller } from '../polling/poller.js';
import { noHistory } from '../recording/testSupport.js';
import { DEVICE_COOKIE, SESSION_COOKIE } from './authRoutes.js';
import { ProxySettings } from './proxySettings.js';
import { SESSION_LIFETIME_SECONDS } from './sessionStore.js';
import { authParts } from './testSupport.js';
import type { UserAccounts } from './userAccounts.js';

/** The login routes with a known device cookie: a browser where the user logged in before */

const PROXY = '127.0.0.1';
const fromProxy = { incoming: { socket: { remoteAddress: PROXY } } };
const ADMIN = { username: 'admin', password: 'first-password' };
const BOB = { username: 'bob', password: 'bob-password' };
const WRONG = { ...ADMIN, password: 'wrong-password' };
const ADMIN_COMPUTER = '192.168.1.20';
const DAY_SECONDS = 24 * 60 * 60;

describe('known device cookie', () => {
  let app: ReturnType<typeof createApp>;
  let accounts: UserAccounts;

  beforeEach(async () => {
    const parts = authParts();
    accounts = parts.accounts;
    app = createApp({
      poller: new HardwarePoller(new Database(':memory:')),
      auth: parts.auth,
      accounts,
      history: noHistory(),
      proxySettings: ProxySettings.inMemory(PROXY),
    });
    await send(ADMIN_COMPUTER, '/api/auth/setup', ADMIN);
    await accounts.add({ ...BOB, role: 'operator' });
  });

  /** A request that the proxy sends on for a computer, with the cookies of a browser */
  function send(address: string, path: string, body: object, { cookie = '', protocol = 'http' } = {}) {
    return app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': address, 'X-Forwarded-Proto': protocol, Cookie: cookie,
      },
      body: JSON.stringify(body),
    }, fromProxy);
  }

  /** The Set-Cookie line of one cookie in the reply, or undefined */
  const setCookieLine = (res: Response, name: string) => res.headers.getSetCookie().find(line => line.startsWith(`${name}=`));

  /** The "name=value" part of the device cookie that the reply sets */
  function deviceCookie(res: Response): string {
    const line = setCookieLine(res, DEVICE_COOKIE);
    expect(line).toBeDefined();
    return line!.split(';')[0];
  }

  async function knownDeviceOf(login: typeof ADMIN, address = ADMIN_COMPUTER): Promise<string> {
    const res = await send(address, '/api/auth/login', login);
    expect(res.status).toBe(200);
    return deviceCookie(res);
  }

  /** 30 wrong passwords from 6 other computers lock the user on all addresses */
  async function lockUser(login: typeof ADMIN = ADMIN) {
    for (let i = 0; i < 30; i++) await send(`192.168.2.${Math.floor(i / 5)}`, '/api/auth/login', { ...login, password: 'wrong-password' });
    expect((await send('192.168.3.1', '/api/auth/login', login)).status).toBe(429);
  }

  it('gives a device cookie after a good login: HttpOnly, SameSite=Strict, only for /api/auth, for 400 days', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
    const line = setCookieLine(res, DEVICE_COOKIE)!;

    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Strict');
    expect(line).toContain('Path=/api/auth');
    expect(line).toContain(`Max-Age=${400 * DAY_SECONDS}`);
    expect(line).not.toContain('Secure');
    expect(line).not.toContain(ADMIN.password);
    // The session cookie stays a separate cookie for the whole site
    expect(setCookieLine(res, SESSION_COOKIE)).toContain('Path=/;');
  });

  it('keeps the device cookie longer than the session, so the browser is still known when the session ends', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
    const maxAgeOf = (name: string) => Number(/Max-Age=(\d+)/.exec(setCookieLine(res, name)!)?.[1]);

    expect(maxAgeOf(SESSION_COOKIE)).toBe(SESSION_LIFETIME_SECONDS);
    expect(maxAgeOf(DEVICE_COOKIE)).toBeGreaterThan(SESSION_LIFETIME_SECONDS);
  });

  it('makes the device cookie HTTPS-only when the browser used HTTPS', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { protocol: 'https' });
    expect(setCookieLine(res, DEVICE_COOKIE)).toContain('Secure');
  });

  it('gives no device cookie after a wrong password', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', WRONG);
    expect(setCookieLine(res, DEVICE_COOKIE)).toBeUndefined();
  });

  it('gives a device cookie also to the first admin at setup', async () => {
    const parts = authParts();
    app = createApp({
      poller: new HardwarePoller(new Database(':memory:')), auth: parts.auth, accounts: parts.accounts, history: noHistory(),
      proxySettings: ProxySettings.inMemory(PROXY),
    });
    const cookie = deviceCookie(await send(ADMIN_COMPUTER, '/api/auth/setup', ADMIN));
    await lockUser();

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(200);
  });

  it('lets a known device log in while the user is locked on all addresses', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    await lockUser();

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(200);
  });

  it('knows the device for the username with spaces and other case, as the login form reads it', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    await lockUser();

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', { ...ADMIN, username: ' Admin ' }, { cookie })).status).toBe(200);
  });

  it('lets a known device log in while its address is locked for the user', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    for (let i = 0; i < 10; i++) await send(ADMIN_COMPUTER, '/api/auth/login', WRONG);
    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN)).status).toBe(429);

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(200);
  });

  it('lets a known device change the password while the user is locked', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
    const cookie = `${res.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')}`;
    await lockUser();

    const change = await send(ADMIN_COMPUTER, '/api/auth/password',
      { currentPassword: ADMIN.password, newPassword: 'second-password' }, { cookie });
    expect(change.status).toBe(200);
  });

  it('stops a known device after 10 wrong passwords, also with the right password', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    for (let i = 0; i < 10; i++) expect((await send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie })).status).toBe(401);

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(429);
  });

  it('does not count the wrong passwords of a known device for the user or its address', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    for (let i = 0; i < 10; i++) await send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie });

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN)).status).toBe(200);
  });

  it('lets only 10 of many tries sent at the same time from a known device check the password', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    const replies = await Promise.all(Array.from({ length: 30 }, () => send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie })));

    expect(replies.filter(reply => reply.status === 401)).toHaveLength(10);
  });

  it('uses the normal limits for a device cookie of a different user', async () => {
    const cookie = await knownDeviceOf(BOB);
    await lockUser();

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(429);
  });

  it('uses the normal limits for a changed or a made-up device cookie', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    await lockUser();
    const [name, value] = cookie.split('=');
    // Change the first character of the signature: the last one has bits that the decoder ignores
    const signatureAt = value.lastIndexOf('.') + 1;
    const changed = `${name}=${value.slice(0, signatureAt)}${value[signatureAt] === 'A' ? 'B' : 'A'}${value.slice(signatureAt + 1)}`;
    const madeUp = `${name}=1.${'A'.repeat(22)}.${'A'.repeat(43)}`;

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: changed })).status).toBe(429);
    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: madeUp })).status).toBe(429);
  });

  it('uses the normal limits for a program login (HTTP Basic), also when it sends a device cookie', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    await lockUser();
    const authorization = `Basic ${Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64')}`;

    const res = await app.request('/api/machines', {
      headers: { 'X-Forwarded-For': ADMIN_COMPUTER, Authorization: authorization, Cookie: cookie },
    }, fromProxy);
    expect(res.status).toBe(429);
  });

  it('stops the device cookie when the password changes, and gives the browser a new one', async () => {
    const login = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
    const oldDevice = deviceCookie(login);
    const cookies = login.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
    const change = await send(ADMIN_COMPUTER, '/api/auth/password',
      { currentPassword: ADMIN.password, newPassword: 'second-password' }, { cookie: cookies });
    const newDevice = deviceCookie(change);
    const newLogin = { ...ADMIN, password: 'second-password' };
    await lockUser(newLogin);

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', newLogin, { cookie: oldDevice })).status).toBe(429);
    expect((await send(ADMIN_COMPUTER, '/api/auth/login', newLogin, { cookie: newDevice })).status).toBe(200);
  });

  it('gives a new device ID at each login, so the wrong passwords of an old copy of the cookie do not stop the browser', async () => {
    const old = await knownDeviceOf(ADMIN);
    const again = deviceCookie(await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: old }));
    expect(again.split('.')[1]).not.toBe(old.split('.')[1]);
    await lockUser();
    for (let i = 0; i < 10; i++) await send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie: old });

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: old })).status).toBe(429);
    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: again })).status).toBe(200);
  });

  describe('log out all other browsers', () => {
    const LOG_OUT_OTHERS = '/api/auth/sessions/log-out-others';
    /** The session cookie and the device cookie of a browser that logs in */
    async function browserOf(login: typeof ADMIN): Promise<{ cookies: string; device: string }> {
      const res = await send(ADMIN_COMPUTER, '/api/auth/login', login);
      expect(res.status).toBe(200);
      return { cookies: res.headers.getSetCookie().map(line => line.split(';')[0]).join('; '), device: deviceCookie(res) };
    }

    it('stops the device cookies of the other browsers of the user, and gives this browser a new one', async () => {
      const thisBrowser = await browserOf(ADMIN);
      const otherBrowser = await browserOf(ADMIN);

      const res = await send(ADMIN_COMPUTER, LOG_OUT_OTHERS, {}, { cookie: thisBrowser.cookies });
      expect(res.status).toBe(200);
      const newDevice = deviceCookie(res);
      expect(setCookieLine(res, DEVICE_COOKIE)).toContain(`Max-Age=${400 * DAY_SECONDS}`);
      await lockUser();

      expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: otherBrowser.device })).status).toBe(429);
      // The cookie of this browser from before is also old now
      expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: thisBrowser.device })).status).toBe(429);
      expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: newDevice })).status).toBe(200);
    });

    it('gives no device cookie to a browser that is not a known browser', async () => {
      const login = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
      const sessionOnly = setCookieLine(login, SESSION_COOKIE)!.split(';')[0];

      const res = await send(ADMIN_COMPUTER, LOG_OUT_OTHERS, {}, { cookie: sessionOnly });
      expect(res.status).toBe(200);
      expect(setCookieLine(res, DEVICE_COOKIE)).toBeUndefined();
    });

    it('does not stop the device cookies of a different user', async () => {
      const adminBrowser = await browserOf(ADMIN);
      const bobBrowser = await browserOf(BOB);

      await send(ADMIN_COMPUTER, LOG_OUT_OTHERS, {}, { cookie: bobBrowser.cookies });
      await lockUser(ADMIN);
      expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie: adminBrowser.device })).status).toBe(200);

      const bobDevice = deviceCookie(await send(ADMIN_COMPUTER, '/api/auth/login', BOB));
      await send(ADMIN_COMPUTER, LOG_OUT_OTHERS, {}, { cookie: adminBrowser.cookies });
      await lockUser(BOB);
      expect((await send(ADMIN_COMPUTER, '/api/auth/login', BOB, { cookie: bobDevice })).status).toBe(200);
    });
  });

  describe('server log', () => {
    let log: CapturedLog | undefined;
    afterEach(() => {
      log?.restore();
      log = undefined;
    });

    it('tells that a login try used a known device, with its result', async () => {
      const cookie = await knownDeviceOf(ADMIN);
      log = captureLog();
      await send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie });
      await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie });

      const lines = log.lines.filter(line => line.text.includes('knownDevice=true'));
      expect(lines).toHaveLength(2);
      expect(lines[0].text).toContain('username=admin');
      expect(lines[0].text).toContain(`address=${ADMIN_COMPUTER}`);
      expect(lines[0].text).toContain('result=wrong-password');
      expect(lines[1].text).toContain('result=logged-in');
      expect(log.text()).not.toContain(cookie.split('=')[1]);
    });

    it('writes no known device line for a login without a device cookie', async () => {
      log = captureLog();
      await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);

      expect(log.text()).not.toContain('knownDevice');
    });
  });

  it('keeps the device cookie on logout', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/logout', {}, { cookie: await knownDeviceOf(ADMIN) });
    expect(setCookieLine(res, DEVICE_COOKIE)).toBeUndefined();
  });
});
