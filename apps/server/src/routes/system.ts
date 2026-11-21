import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { NetworkInfo } from '@local-chatter/shared';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { createLogger } from '../logging/logger.js';
import { UpdateRefusedError, type UpdateService } from '../updates/UpdateService.js';

const log = createLogger('system');

/** Docker makes this file in every container */
const DOCKER_MARKER_FILE = '/.dockerenv';
/** The reply goes out before the server stops */
const RESTART_DELAY_MS = 500;

/** Settings > Diagnostics: the facts of this computer, and the restart buttons */
export interface SystemFacts {
  version: string;
  /** When this server process started (ISO text). It changes after a restart. */
  startedAt: string;
  /** Chatter runs in Docker, so Docker starts it again after a stop ("restart: unless-stopped") */
  canRestartChatter: boolean;
  /** The update helper of the Pi can restart the Pi (a newer card image) */
  canRestartPi: boolean;
  /** Chatter runs on the Pi card, with the update helper */
  isPiCard: boolean;
  /** The network facts that the helper wrote, or null (a normal computer, or an older card image) */
  network: NetworkInfo | null;
}

export interface SystemOptions {
  version: string;
  /** Ends the process cleanly. Docker starts it again. */
  restartChatter?: () => void;
  isInDocker?: boolean;
  now?: () => number;
}

/** SIGTERM runs the same clean stop as "docker stop": the machines disconnect and the database closes */
function endProcessSoon(): void {
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS);
}

/** The facts of this computer, and a restart of Chatter or of the Pi. Only an admin can do this, and each restart is logged with the user. */
export function systemRoutes(updates: UpdateService, {
  version,
  restartChatter = endProcessSoon,
  isInDocker = existsSync(DOCKER_MARKER_FILE),
  now = Date.now,
}: SystemOptions) {
  const canManageChatter = requirePermission('manage-chatter');
  return new Hono<LoggedInEnv>()
    .get('/system/facts', canManageChatter, async c => {
      const helper = await updates.helper();
      const facts: SystemFacts = {
        version,
        startedAt: new Date(now() - process.uptime() * 1000).toISOString(),
        canRestartChatter: isInDocker,
        canRestartPi: helper?.capabilities?.includes('reboot') ?? false,
        isPiCard: helper !== null,
        network: helper ? await updates.network() : null,
      };
      return c.json(facts);
    })

    .post('/system/restart-chatter', canManageChatter, c => {
      if (!isInDocker) {
        return c.json({ error: 'Chatter does not run in Docker here, so it cannot start again by itself. Restart it by hand.' }, 409);
      }
      log.warn('Restart of Chatter asked', { user: c.var.user.username });
      restartChatter();
      return c.json({ message: 'Chatter restarts now. This takes about 1 minute.' }, 202);
    })

    .post('/system/restart-pi', canManageChatter, async c => {
      try {
        await updates.requestReboot(c.var.user.username);
      } catch (error) {
        if (error instanceof UpdateRefusedError) return c.json({ error: error.message }, error.status);
        throw error;
      }
      return c.json({ message: 'The Pi restarts now. This takes about 2 minutes.' }, 202);
    });
}
