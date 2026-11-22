import { describe, expect, it } from 'vitest';
import { LoginLimiter, MAX_FAILURES, MAX_USER_FAILURES } from './LoginLimiter.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function failTimes(limiter: LoginLimiter, address: string, times: number, username = 'admin') {
  for (let i = 0; i < times; i++) limiter.recordAttempt(address, username);
}

/** Wrong passwords for one user from many addresses, at most 5 from each address */
function failFromManyAddresses(limiter: LoginLimiter, username: string, times: number) {
  for (let i = 0; i < times; i++) limiter.recordAttempt(`10.0.${Math.floor(i / 5)}.1`, username);
}

describe('LoginLimiter', () => {
  it('blocks an address for one user after 10 password tries', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 9);
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(false);

    limiter.recordAttempt('10.0.0.5', 'admin');
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(true);
    expect(limiter.isBlocked('10.0.0.6', 'admin')).toBe(false);
  });

  it('does not block the other users of a shared address', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 10, 'admin');
    expect(limiter.isBlocked('10.0.0.5', 'bob')).toBe(false);
  });

  it('forgets the failures of the user after a good password', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 9);
    limiter.recordAttempt('10.0.0.5', 'admin');
    limiter.recordSuccess('10.0.0.5', 'admin');
    limiter.recordAttempt('10.0.0.5', 'admin');
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(false);
  });

  it('keeps the failures of another user after a good password from the same address', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 9, 'admin');
    limiter.recordAttempt('10.0.0.5', 'bob');
    limiter.recordSuccess('10.0.0.5', 'bob');

    limiter.recordAttempt('10.0.0.5', 'admin');
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(true);
  });

  it('counts the username as the login reads it, with no case and no spaces at the ends', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 5, 'Admin');
    failTimes(limiter, '10.0.0.5', 5, ' admin ');
    expect(limiter.isBlocked('10.0.0.5', 'ADMIN')).toBe(true);
  });

  it('counts the tries from two IPv6 addresses in one /64 together', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '2001:db8:1:2::66', 5);
    failTimes(limiter, '2001:db8:1:2:aaaa:bbbb:cccc:dddd', 5);

    expect(limiter.isBlocked('2001:db8:1:2::1', 'admin')).toBe(true);
    expect(limiter.isBlocked('2001:db8:1:3::1', 'admin')).toBe(false);
  });

  it('blocks a user on all addresses after 30 tries from many addresses', () => {
    expect(MAX_USER_FAILURES).toBe(30);
    const limiter = new LoginLimiter();
    failFromManyAddresses(limiter, 'admin', MAX_USER_FAILURES - 1);
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(false);

    limiter.recordAttempt('10.9.9.8', 'admin');
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(true);
    expect(limiter.isBlocked('10.9.9.9', 'bob')).toBe(false);
  });

  it('does not lock a user after 30 good logins', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_USER_FAILURES; i++) {
      const address = `10.0.${i}.1`;
      expect(limiter.isBlocked(address, 'admin')).toBe(false);
      limiter.recordAttempt(address, 'admin');
      limiter.recordSuccess(address, 'admin');
    }

    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(false);
    expect(limiter.lockedUsers()).toEqual([]);
  });

  it('keeps the wrong passwords of the user on all addresses after a good password', () => {
    const limiter = new LoginLimiter();
    failFromManyAddresses(limiter, 'admin', MAX_USER_FAILURES - 1);
    limiter.recordAttempt('10.8.8.8', 'admin');
    limiter.recordSuccess('10.8.8.8', 'admin');
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(false);

    limiter.recordAttempt('10.9.9.8', 'admin');
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(true);
  });

  it('reports the first blocked try again when a good login ends a user lock and a new lock starts', () => {
    const limiter = new LoginLimiter();
    failFromManyAddresses(limiter, 'admin', MAX_USER_FAILURES - 1);
    // The good password of the owner is the try that reaches the limit
    limiter.recordAttempt('10.8.8.8', 'admin');
    expect(limiter.isFirstBlockedTry('10.9.9.9', 'admin')).toBe(true);
    limiter.recordSuccess('10.8.8.8', 'admin');
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(false);

    limiter.recordAttempt('10.9.9.8', 'admin');
    expect(limiter.isFirstBlockedTry('10.9.9.9', 'admin')).toBe(true);
  });

  it('blocks tries that start at the same time, before any check ends', () => {
    const limiter = new LoginLimiter();
    const allowed = Array.from({ length: 50 }).filter(() => {
      if (limiter.isBlocked('10.0.0.5', 'admin')) return false;
      limiter.recordAttempt('10.0.0.5', 'admin');
      return true;
    });
    expect(allowed).toHaveLength(MAX_FAILURES);
  });

  it('never tracks more than 1000 entries', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 1001; i++) limiter.recordAttempt(`address-${i}`, `user-${i}`);
    failTimes(limiter, 'address-1000', 9, 'user-1000');
    expect(limiter.isBlocked('address-1000', 'user-1000')).toBe(true);
    // The oldest entry with the fewest tries was dropped to make room
    failTimes(limiter, 'address-0', 9, 'user-0');
    expect(limiter.isBlocked('address-0', 'user-0')).toBe(false);
  });

  it('keeps the count of a guessed user when many new usernames fill the list', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 9);
    for (let i = 0; i < 2000; i++) limiter.recordAttempt('10.0.0.5', `made-up-${i}`);

    limiter.recordAttempt('10.0.0.5', 'admin');
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(true);
  });

  it('lets the address and the user try again after 15 minutes', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    failTimes(limiter, '10.0.0.5', 10);
    failFromManyAddresses(limiter, 'bob', MAX_USER_FAILURES);

    now = FIFTEEN_MINUTES + 1;
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(false);
    expect(limiter.isBlocked('10.0.0.5', 'bob')).toBe(false);
  });

  it('lists the locked addresses with the username and the end of the lock', () => {
    let now = 1000;
    const limiter = new LoginLimiter(() => now);
    failTimes(limiter, '10.0.0.5', 10, 'Sam');
    failTimes(limiter, '10.0.0.6', 9);
    failTimes(limiter, '2001:db8:1:2::66', 10);

    expect(limiter.lockedAddresses()).toEqual([
      { address: '10.0.0.5', username: 'sam', until: new Date(1000 + FIFTEEN_MINUTES) },
      { address: '2001:db8:1:2::/64', username: 'admin', until: new Date(1000 + FIFTEEN_MINUTES) },
    ]);
    now = 1000 + FIFTEEN_MINUTES + 1;
    expect(limiter.lockedAddresses()).toEqual([]);
  });

  it('lists the users that are locked on all addresses', () => {
    const limiter = new LoginLimiter(() => 1000);
    failFromManyAddresses(limiter, 'Admin', MAX_USER_FAILURES);
    failFromManyAddresses(limiter, 'bob', MAX_USER_FAILURES - 1);

    expect(limiter.lockedUsers()).toEqual([{ username: 'admin', until: new Date(1000 + FIFTEEN_MINUTES) }]);
  });

  it('unlocks all users of an address at once, also by the /64 that the list shows', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 10, 'admin');
    failTimes(limiter, '10.0.0.5', 10, 'bob');
    failTimes(limiter, '2001:db8:1:2::66', 10);

    limiter.unlock('10.0.0.5');
    limiter.unlock('2001:db8:1:2::/64');
    expect(limiter.isBlocked('10.0.0.5', 'admin')).toBe(false);
    expect(limiter.isBlocked('10.0.0.5', 'bob')).toBe(false);
    expect(limiter.isBlocked('2001:db8:1:2::66', 'admin')).toBe(false);
    expect(limiter.lockedAddresses()).toEqual([]);
  });

  it('unlocks a user on all addresses', () => {
    const limiter = new LoginLimiter();
    failFromManyAddresses(limiter, 'admin', MAX_USER_FAILURES);

    limiter.unlockUser('ADMIN');
    expect(limiter.isBlocked('10.9.9.9', 'admin')).toBe(false);
    expect(limiter.lockedUsers()).toEqual([]);
  });

  it('reports only the first blocked try of each lock', () => {
    const limiter = new LoginLimiter();
    failTimes(limiter, '10.0.0.5', 10);

    expect(limiter.isFirstBlockedTry('10.0.0.5', 'admin')).toBe(true);
    expect(limiter.isFirstBlockedTry('10.0.0.5', 'admin')).toBe(false);
    limiter.unlock('10.0.0.5');
    failTimes(limiter, '10.0.0.5', 10);
    expect(limiter.isFirstBlockedTry('10.0.0.5', 'admin')).toBe(true);
  });

  it('reports only the first blocked try of a user lock, from any address', () => {
    const limiter = new LoginLimiter();
    failFromManyAddresses(limiter, 'admin', MAX_USER_FAILURES);

    expect(limiter.isFirstBlockedTry('10.9.9.1', 'admin')).toBe(true);
    expect(limiter.isFirstBlockedTry('10.9.9.2', 'admin')).toBe(false);
  });
});
