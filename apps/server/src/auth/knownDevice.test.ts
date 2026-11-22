import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { HardwarePoller } from '../polling/poller.js';
import { noHistory } from '../recording/testSupport.js';
import { DEVICE_COOKIE, SESSION_COOKIE } from './authRoutes.js';
import { ProxySettings } from './proxySettings.js';
import { authParts } from './testSupport.js';
import type { UserAccounts } from './userAccounts.js';

/** The login routes with a known device cookie: a browser where the user logged in before */

const PROXY = '127.0.0.1';
const fromProxy = { incoming: { socket: { remoteAddress: PROXY } } };
const ADMIN = { username: 'admin', password: 'first-password' };
const BOB = { username: 'bob', password: 'bob-password' };
const WRONG = { ...ADMIN, password: 'wrong-password' };
const ADMIN_COMPUTER = '192.168.1.20';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

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

  it('gives a device cookie after a good login: HttpOnly, SameSite=Strict, only for /api/auth, for 1 year', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN);
    const line = setCookieLine(res, DEVICE_COOKIE)!;

    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Strict');
    expect(line).toContain('Path=/api/auth');
    expect(line).toContain(`Max-Age=${ONE_YEAR_SECONDS}`);
    expect(line).not.toContain('Secure');
    expect(line).not.toContain(ADMIN.password);
    expect(setCookieLine(res, SESSION_COOKIE)).toBeDefined();
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
    app = createApp({ poller: new HardwarePoller(new Database(':memory:')), auth: parts.auth, accounts: parts.accounts, history: noHistory() });
    const res = await send(ADMIN_COMPUTER, '/api/auth/setup', ADMIN);

    expect(setCookieLine(res, DEVICE_COOKIE)).toBeDefined();
  });

  it('lets a known device log in while the user is locked on all addresses', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    await lockUser();

    expect((await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie })).status).toBe(200);
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
    const changed = `${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
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

  it('keeps the device ID at the next login, so the browser keeps its count', async () => {
    const cookie = await knownDeviceOf(ADMIN);
    for (let i = 0; i < 9; i++) await send(ADMIN_COMPUTER, '/api/auth/login', WRONG, { cookie });
    const again = deviceCookie(await send(ADMIN_COMPUTER, '/api/auth/login', ADMIN, { cookie }));

    expect(again.split('.')[1]).toBe(cookie.split('.')[1]);
  });

  it('keeps the device cookie on logout', async () => {
    const res = await send(ADMIN_COMPUTER, '/api/auth/logout', {}, { cookie: await knownDeviceOf(ADMIN) });
    expect(setCookieLine(res, DEVICE_COOKIE)).toBeUndefined();
  });
});
