import { describe, expect, it, vi } from 'vitest';
import { captureLog } from '../logging/testSupport.js';
import { PromoteNotConfirmedError, resetAdmins } from './adminReset.js';
import { hashPassword } from './passwords.js';
import { authParts } from './testSupport.js';

const BROWSER = { userAgent: 'test browser', address: '192.168.1.20' };

/** The parts, with an Admin, an Operator and a Viewer that are each logged in on one browser */
async function shop() {
  const parts = authParts();
  const { auth, accounts, users } = parts;
  const adminSession = (await auth.setUp({ username: 'admin', password: 'admin-password' }, BROWSER))!;
  const sam = await accounts.add({ username: 'sam', password: 'sam-password', role: 'operator' });
  const vic = await accounts.add({ username: 'vic', password: 'vic-password', role: 'viewer' });
  const samSession = (await auth.logIn({ username: 'sam', password: 'sam-password' }, BROWSER))!;
  const samDevice = auth.deviceCookieFor('sam');
  return { ...parts, admin: users.findByName('admin')!, sam, vic, adminSession, samSession, samDevice };
}

const newAdmin = async (username: string, password = 'new-admin-password') =>
  ({ username, passwordHash: await hashPassword(password) });

const roles = (users: ReturnType<typeof authParts>['users']) =>
  users.list().map(({ username, role }) => `${username}: ${role}`);

describe('resetAdmins (npm run reset-password)', () => {
  it('replaces the Admins with one new Admin, logs out each browser, and stops each device cookie', async () => {
    const { users, sessions, auth, sam, admin, samSession, adminSession, samDevice } = await shop();

    expect(resetAdmins(users, sessions, await newAdmin('boss'))).toBe('created');

    expect(roles(users)).toEqual(['boss: admin', 'sam: operator', 'vic: viewer']);
    expect(users.find(admin.id)).toBeNull();
    expect(users.find(sam.id)).not.toBeNull();
    expect(auth.sessionOf(samSession)).toBeNull();
    expect(auth.sessionOf(adminSession)).toBeNull();
    expect(auth.knownDeviceOf(samDevice, 'sam')).toBeNull();
    expect(await auth.logIn({ username: 'boss', password: 'new-admin-password' }, BROWSER)).not.toBeNull();
    expect(await auth.logIn({ username: 'admin', password: 'admin-password' }, BROWSER)).toBeNull();
  });

  it('keeps the setup closed', async () => {
    const { users, sessions, auth } = await shop();

    resetAdmins(users, sessions, await newAdmin('boss'));

    expect(auth.isSetUp()).toBe(true);
    expect(await auth.setUp({ username: 'intruder', password: 'intruder-password' }, BROWSER)).toBeNull();
  });

  it('gives the name of the old Admin to a new account, so the old logins cannot come back', async () => {
    const { users, sessions, auth, admin } = await shop();

    resetAdmins(users, sessions, await newAdmin('admin'));

    const replaced = users.findByName('admin')!;
    expect(replaced.role).toBe('admin');
    expect(replaced.id).not.toBe(admin.id);
    expect(await auth.logIn({ username: 'admin', password: 'new-admin-password' }, BROWSER)).not.toBeNull();
  });

  it('removes each Admin when there are more than one', async () => {
    const { users, sessions, accounts } = await shop();
    await accounts.add({ username: 'second-admin', password: 'second-password', role: 'admin' });

    resetAdmins(users, sessions, await newAdmin('boss'));

    expect(users.list().filter(user => user.role === 'admin').map(user => user.username)).toEqual(['boss']);
  });

  it('promotes an Operator to Admin with the new password when the person confirmed it', async () => {
    const { users, sessions, auth, sam, samSession } = await shop();

    expect(resetAdmins(users, sessions, await newAdmin('SAM'), { promote: true })).toBe('promoted');

    expect(roles(users)).toEqual(['sam: admin', 'vic: viewer']);
    expect(users.find(sam.id)!.role).toBe('admin');
    expect(auth.sessionOf(samSession)).toBeNull();
    expect(await auth.logIn({ username: 'sam', password: 'sam-password' }, BROWSER)).toBeNull();
    expect(await auth.logIn({ username: 'sam', password: 'new-admin-password' }, BROWSER)).not.toBeNull();
  });

  it('changes nothing when the name belongs to a Viewer and the person did not confirm the promotion', async () => {
    const { users, sessions, auth, vic, adminSession } = await shop();
    const before = roles(users);

    expect(() => resetAdmins(users, sessions, { username: 'vic', passwordHash: 'x' })).toThrow(PromoteNotConfirmedError);

    expect(roles(users)).toEqual(before);
    expect(users.find(vic.id)!.passwordHash).not.toBe('x');
    expect(auth.sessionOf(adminSession)).not.toBeNull();
  });

  it('changes nothing when a step fails', async () => {
    const { users, sessions, auth, adminSession, samDevice } = await shop();
    const before = roles(users);
    const admin = await newAdmin('boss');
    vi.spyOn(users, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => resetAdmins(users, sessions, admin)).toThrow('disk full');

    expect(roles(users)).toEqual(before);
    expect(auth.sessionOf(adminSession)).not.toBeNull();
    expect(auth.knownDeviceOf(samDevice, 'sam')).not.toBeNull();
  });

  it('changes nothing when the new password of a promoted user cannot be saved', async () => {
    const { users, sessions, auth, samSession } = await shop();
    const before = roles(users);
    const admin = await newAdmin('sam');
    vi.spyOn(users, 'setPasswordHash').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => resetAdmins(users, sessions, admin, { promote: true })).toThrow('disk full');

    expect(roles(users)).toEqual(before);
    expect(auth.sessionOf(samSession)).not.toBeNull();
  });

  it('writes a warn line with the name of the new Admin, but not the password', async () => {
    const { users, sessions } = await shop();
    const log = captureLog();
    try {
      const admin = await newAdmin('boss', 'secret-password');
      resetAdmins(users, sessions, admin);

      const lines = log.lines.filter(line => line.level === 'warn');
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toContain('username=boss');
      expect(log.text()).not.toContain('secret-password');
      expect(log.text()).not.toContain(admin.passwordHash);
    } finally {
      log.restore();
    }
  });
});
