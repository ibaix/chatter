import type { SessionStore } from './sessionStore.js';
import type { UserStore } from './userStore.js';

/**
 * The password reset from the command line: remove the admin accounts, and log out each browser.
 * The users who are not admins stay, but their browsers are not known browsers any more.
 */
export function resetAdmins(users: UserStore, sessions: SessionStore): void {
  users.inTransaction(() => {
    users.removeAdmins();
    sessions.deleteAll();
    users.forgetAllDevices();
  });
}
