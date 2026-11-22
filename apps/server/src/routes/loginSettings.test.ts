import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from '../auth/Auth.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { LoginLog } from '../auth/loginLog.js';
import { loggedInAuth, TEST_LOGIN } from '../auth/testSupport.js';
import { errorOf, testApp, type TestApp } from './testSupport.js';

const ATTACKER = '192.168.1.66';
/** The computer of the admin */
const ADMIN_COMPUTER = '192.168.1.20';
/** A connection from this address, as the Node server gives it */
const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

interface LoginsReport {
  limits: { maxWrongPasswords: number; maxWrongPasswordsForUser: number; lockMinutes: number };
  locked: { address: string; username: string; until: string }[];
  lockedUsers: { username: string; until: string }[];
  tries: { at: string; username: string; address: string; result: string }[];
}

describe('login settings routes', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let cookie: string;
  let app: TestApp;

  beforeAll(async () => {
    ({ auth, accounts, cookie } = await loggedInAuth());
  });

  beforeEach(() => {
    app = testApp({ auth, accounts, loginLog: LoginLog.inMemory() });
  });

  function logIn(username: string, password: string, address = ATTACKER) {
    return app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }, from(address));
  }

  function asAdmin(path: string, body?: object) {
    return app.request(path, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    }, from(ADMIN_COMPUTER));
  }

  async function lockOut(address: string) {
    for (let i = 0; i < 10; i++) await logIn('sam', 'wrong-password', address);
  }

  it('needs a login', async () => {
    expect((await app.request('/api/settings/logins')).status).toBe(401);
  });

  it('lists the tries, the newest first', async () => {
    await logIn('sam', 'wrong-password');
    await logIn(TEST_LOGIN.username, TEST_LOGIN.password);

    const report = (await (await asAdmin('/api/settings/logins')).json()) as LoginsReport;
    expect(report.tries).toEqual([
      { at: expect.any(String), username: TEST_LOGIN.username, address: ATTACKER, result: 'logged-in' },
      { at: expect.any(String), username: 'sam', address: ATTACKER, result: 'no-such-user' },
    ]);
    expect(report.locked).toEqual([]);
    expect(report.lockedUsers).toEqual([]);
    expect(report.limits).toEqual({ maxWrongPasswords: 10, maxWrongPasswordsForUser: 30, lockMinutes: 15 });
  });

  it('lists a locked computer, and unlocks it', async () => {
    await lockOut(ATTACKER);
    const before = (await (await asAdmin('/api/settings/logins')).json()) as LoginsReport;
    expect(before.locked).toEqual([{ address: ATTACKER, username: 'sam', until: expect.any(String) }]);

    const res = await asAdmin('/api/settings/logins/unlock', { address: ATTACKER });

    expect(res.status).toBe(200);
    expect(((await res.json()) as LoginsReport).locked).toEqual([]);
    expect((await logIn('sam', 'wrong-password')).status).toBe(401);
  });

  it('unlocks only the IPv4 address that the admin gives', async () => {
    await lockOut(ATTACKER);
    await lockOut('192.168.1.67');

    await asAdmin('/api/settings/logins/unlock', { address: ATTACKER });

    expect((await logIn('sam', 'wrong-password')).status).toBe(401);
    expect((await logIn('sam', 'wrong-password', '192.168.1.67')).status).toBe(429);
  });

  it('lists a user that is locked on all addresses, and unlocks it', async () => {
    for (let i = 0; i < 30; i++) await logIn('sam', 'wrong-password', `192.168.2.${Math.floor(i / 5)}`);
    const before = (await (await asAdmin('/api/settings/logins')).json()) as LoginsReport;
    expect(before.lockedUsers).toEqual([{ username: 'sam', until: expect.any(String) }]);

    const res = await asAdmin('/api/settings/logins/unlock', { username: 'Sam' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as LoginsReport).lockedUsers).toEqual([]);
    expect((await logIn('sam', 'wrong-password', '192.168.3.1')).status).toBe(401);
  });

  it('refuses an unlock with no address', async () => {
    const res = await asAdmin('/api/settings/logins/unlock', { address: ' ' });
    expect(res.status).toBe(400);
  });

  it('refuses an unlock with no address and no username', async () => {
    const res = await asAdmin('/api/settings/logins/unlock', {});
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Give an address or a username to unlock');
  });
});
