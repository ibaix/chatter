import { describe, expect, it, vi } from 'vitest';
import { resetAdmins } from './adminReset.js';
import { authParts } from './testSupport.js';

const BROWSER = { userAgent: 'test browser', address: '192.168.1.20' };

describe('resetAdmins (npm run reset-password)', () => {
  it('removes the admins, logs out each browser, and stops the device cookies of the users that stay', async () => {
    const { users, sessions, auth, accounts } = authParts();
    await auth.setUp({ username: 'admin', password: 'admin-password' }, BROWSER);
    const sam = await accounts.add({ username: 'sam', password: 'sam-password', role: 'operator' });
    const samSession = (await auth.logIn({ username: 'sam', password: 'sam-password' }, BROWSER))!;
    const samDevice = auth.deviceCookieFor('sam');

    resetAdmins(users, sessions);

    expect(users.hasAdmin()).toBe(false);
    expect(users.find(sam.id)).not.toBeNull();
    expect(auth.sessionOf(samSession)).toBeNull();
    expect(auth.knownDeviceOf(samDevice, 'sam')).toBeNull();
  });

  it('changes nothing when the device cookies cannot stop', async () => {
    const { users, sessions, auth } = authParts();
    const adminSession = (await auth.setUp({ username: 'admin', password: 'admin-password' }, BROWSER))!;
    vi.spyOn(users, 'forgetAllDevices').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => resetAdmins(users, sessions)).toThrow('disk full');

    expect(users.hasAdmin()).toBe(true);
    expect(auth.sessionOf(adminSession)).not.toBeNull();
  });
});
