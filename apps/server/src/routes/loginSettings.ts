import { Hono } from 'hono';
import { LOCK_MINUTES, MAX_FAILURES, MAX_USER_FAILURES, type LoginLimiter } from '../auth/LoginLimiter.js';
import type { LoginLog } from '../auth/loginLog.js';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import type { ProxySettings } from '../auth/proxySettings.js';
import { originOf } from '../auth/requestOrigin.js';
import { createLogger } from '../logging/logger.js';
import { checkedJson } from './checks.js';
import { unlockSchema } from './schemas.js';

const log = createLogger('auth');

interface LoginSettingsParts {
  limiter: LoginLimiter;
  loginLog: LoginLog;
  proxySettings: ProxySettings;
}

/** What the Settings page shows on the "Logins" tab */
function loginsReport({ limiter, loginLog }: LoginSettingsParts) {
  return {
    limits: { maxWrongPasswords: MAX_FAILURES, maxWrongPasswordsForUser: MAX_USER_FAILURES, lockMinutes: LOCK_MINUTES },
    locked: limiter.lockedAddresses().map(locked => ({ ...locked, until: locked.until.toISOString() })),
    lockedUsers: limiter.lockedUsers().map(locked => ({ ...locked, until: locked.until.toISOString() })),
    tries: loginLog.recent().map(loginTry => ({ ...loginTry, at: loginTry.at.toISOString() })),
  };
}

/** Read the last password tries, and unlock a computer or a user after too many wrong passwords. Only an admin can do this. */
export function loginSettingsRoutes(parts: LoginSettingsParts) {
  const canManageChatter = requirePermission('manage-chatter');
  return new Hono<LoggedInEnv>()
    .get('/settings/logins', canManageChatter, c => c.json(loginsReport(parts)))

    .post('/settings/logins/unlock', canManageChatter, checkedJson(unlockSchema), c => {
      const { address, username } = c.req.valid('json');
      if (address !== undefined) parts.limiter.unlock(address);
      if (username !== undefined) parts.limiter.unlockUser(username);
      // An unlock lets someone guess again, so the log keeps who did it
      log.info('Login lock removed', {
        by: c.var.user.username, from: originOf(c, parts.proxySettings).address, address, username,
      });
      return c.json(loginsReport(parts));
    });
}
