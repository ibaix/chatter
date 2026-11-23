import { api } from '../api/client';
import { useRefreshWhileVisible } from './useRefreshWhileVisible';

/**
 * The server ends a login that is not used for 14 days, and it saves a use at most once each minute.
 * A few minutes is much shorter than 14 days, and it sends few requests.
 */
export const LOGIN_IN_USE_EVERY_MS = 5 * 60 * 1000;

/**
 * While the page is visible, tell the server from time to time that its login is in use.
 * So a dashboard on a wall stays logged in. A hidden or forgotten tab sends nothing, and its login ends after 14 days.
 * A 401 reply (the login is gone) shows the login page.
 */
export function useLoginInUse() {
  useRefreshWhileVisible(tellLoginInUse, LOGIN_IN_USE_EVERY_MS);
}

async function tellLoginInUse() {
  try {
    await api.auth.sessions['in-use'].$post();
  } catch {
    // No connection to Chatter. The live status shows that, and the next interval tries again.
  }
}
