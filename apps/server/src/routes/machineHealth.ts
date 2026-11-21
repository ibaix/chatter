import { Hono } from 'hono';
import type { MachineHealth } from '@local-chatter/shared';
import type { HardwarePoller } from '../polling/poller.js';
import type { ConnectionHealth } from '../logging/ConnectionLog.js';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { createLogger } from '../logging/logger.js';
import { notFound } from './responses.js';

const log = createLogger('machines');

/** The part of the connection log that the routes read */
export interface ConnectionHealthSource {
  health(machineId: string): ConnectionHealth;
}

export const RECONNECT_MESSAGES = {
  started: 'Chatter disconnected the machine, and polls it again now.',
  'poll-in-progress': 'A poll of this machine has not ended, so Chatter does not start a second poll. '
    + 'Chatter disconnected the machine. If the machine stays offline for some minutes, restart Chatter in Settings > Diagnostics.',
  'not-polled': 'Chatter does not poll this machine now. Try again in some seconds.',
} as const;

/** Why a machine is offline and since when, and a reconnect of one machine */
export function machineHealthRoutes(poller: HardwarePoller, connections: ConnectionHealthSource) {
  const canManageMachines = requirePermission('manage-machines');
  return new Hono<LoggedInEnv>()
    .get('/machine/:id/health', c => {
      const id = c.req.param('id');
      const machine = poller.getMachine(id);
      if (!machine) return notFound(c);
      const health: MachineHealth = { ...connections.health(id), lastPollTime: machine.lastPollTime, pollClock: poller.pollClock(id) };
      return c.json(health);
    })

    .post('/machine/:id/reconnect', canManageMachines, c => {
      const id = c.req.param('id');
      const result = poller.reconnectMachine(id);
      if (result === null) return notFound(c);
      log.info('Reconnect asked', { machine: id, user: c.var.user.username, result });
      if (result !== 'started') return c.json({ error: RECONNECT_MESSAGES[result] }, 409);
      return c.json({ message: RECONNECT_MESSAGES.started });
    });
}
