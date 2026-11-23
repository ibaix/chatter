import { createLogger } from '../logging/logger.js';
import type { SessionStore } from './sessionStore.js';
import type { NewUser, UserStore } from './userStore.js';

const log = createLogger('auth');

/** 'created': a new user. 'promoted': a user who was not an Admin is now the Admin. */
export type AdminReset = 'created' | 'promoted';

/** The username belongs to an Operator or a Viewer, and the person did not confirm that this user becomes the Admin */
export class PromoteNotConfirmedError extends Error {
  constructor(username: string) {
    super(`The user ${username} exists already, and is not an Admin.`);
  }
}

/**
 * The password reset from the command line: replace the Admins with one new Admin, and log out each browser.
 *
 * The old Admin accounts are removed, not made into Viewers. Nobody knows their password, or a person who should not
 * have it knows it. A removed account cannot log in again. The new Admin is always a new account, also when it has
 * the name of an old Admin, so the old logins of that name cannot come back.
 * The Operators and Viewers stay, but no browser is a known browser any more.
 *
 * When `username` belongs to an Operator or a Viewer, that user becomes the Admin with the new password,
 * but only with `promote` (the person typed PROMOTE). Else it throws PromoteNotConfirmedError.
 *
 * It is one transaction: when a step fails, nothing changes. An Admin exists before and after it,
 * so the first-run setup does not open.
 */
export function resetAdmins(
  users: UserStore,
  sessions: SessionStore,
  { username, passwordHash }: Omit<NewUser, 'role'>,
  { promote = false }: { promote?: boolean } = {},
): AdminReset {
  const result = users.inTransaction((): AdminReset => {
    const existing = users.findByName(username);
    if (existing && existing.role !== 'admin' && !promote) throw new PromoteNotConfirmedError(existing.username);
    users.removeAdmins();
    sessions.deleteAll();
    users.forgetAllDevices();
    const promoted = users.findByName(username);
    if (!promoted) {
      users.add({ username, passwordHash, role: 'admin' });
      return 'created';
    }
    users.setRole(promoted.id, 'admin');
    users.setPasswordHash(promoted.id, passwordHash);
    return 'promoted';
  });
  // Only a person with access to the server can do this, but it changes who controls Chatter
  log.warn('reset-password made a new Admin', { username, promoted: result === 'promoted' });
  return result;
}
