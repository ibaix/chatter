import Database from 'better-sqlite3';
import type { MachineHealth } from '@local-chatter/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/authRoutes.js';
import { loggedInAuth } from '../auth/testSupport.js';
import type { Auth } from '../auth/Auth.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { ConnectionLog } from '../logging/ConnectionLog.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { HardwarePoller } from '../polling/poller.js';
import { applySchema } from '../storage/schema.js';
import { RECONNECT_MESSAGES } from './machineHealth.js';
import { errorOf, testApp } from './testSupport.js';

/** A port where nothing listens, so each poll fails at once */
const CLOSED_PORT = 1;

describe('machine health routes', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let cookie: string;
  let viewerCookie: string;
  let poller: HardwarePoller;
  let connections: ConnectionLog;
  let machineId: string;
  let log: CapturedLog;

  beforeAll(async () => {
    ({ auth, accounts, cookie } = await loggedInAuth());
    const login = { username: 'viewer', password: 'test-password' };
    await accounts.add({ ...login, role: 'viewer' });
    viewerCookie = `${SESSION_COOKIE}=${await auth.logIn(login, { userAgent: 'test browser', address: '127.0.0.1' })}`;
  });

  beforeEach(async () => {
    log = captureLog();
    const db = new Database(':memory:');
    applySchema(db);
    poller = new HardwarePoller(db);
    connections = new ConnectionLog(undefined, undefined, id => poller.isConnecting(id));
    poller.addRecorder(connections);
    machineId = (await poller.addMachine({ type: 'brother', name: 'Speedio', host: '127.0.0.1', dataPort: CLOSED_PORT })).id;
  });

  afterEach(() => {
    poller.stop();
    log.restore();
    vi.restoreAllMocks();
  });

  const app = () => testApp({ auth, accounts, poller, connections });
  const request = (path: string, method = 'GET', as = cookie) => app().request(path, { method, headers: { Cookie: as } });

  describe('GET /machine/:id/health', () => {
    it('tells each logged-in user the health of a machine', async () => {
      const res = await request(`/api/machine/${machineId}/health`, 'GET', viewerCookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ offlineSince: null, lastError: null, events: [], lastPollTime: null, pollClock: null });
    });

    it('tells the last error, the changes, and the poll times of a polled machine', async () => {
      poller.start();
      await vi.waitFor(() => expect(connections.health(machineId).lastError).not.toBeNull());
      const health = await (await request(`/api/machine/${machineId}/health`)).json() as MachineHealth;
      expect(health.lastError?.text).toMatch(/ECONNREFUSED/);
      expect(health.pollClock).toMatchObject({ overdueAfterMs: 60_000 });
    });

    it('gives 404 for an unknown machine', async () => {
      expect((await request('/api/machine/nope/health')).status).toBe(404);
    });
  });

  describe('POST /machine/:id/reconnect', () => {
    it('polls the machine again, and logs who asked', async () => {
      poller.start();
      // The first poll ends: a closed port refuses at once
      await vi.waitFor(() => expect(connections.health(machineId).lastError).not.toBeNull());
      await vi.waitFor(() => expect(poller.pollClock(machineId)?.inProgressSince).toBeNull());
      const res = await request(`/api/machine/${machineId}/reconnect`, 'POST');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: RECONNECT_MESSAGES.started });
      expect(log.text()).toContain(`Reconnect asked machine=${machineId} user=admin result=started`);
    });

    it('says so when a poll has not ended, and starts no second poll', async () => {
      vi.spyOn(poller, 'reconnectMachine').mockReturnValue('poll-in-progress');
      const res = await request(`/api/machine/${machineId}/reconnect`, 'POST');
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(RECONNECT_MESSAGES['poll-in-progress']);
    });

    it('says so when the machine is not polled', async () => {
      const res = await request(`/api/machine/${machineId}/reconnect`, 'POST');
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(RECONNECT_MESSAGES['not-polled']);
    });

    it('needs the manage-machines role', async () => {
      expect((await request(`/api/machine/${machineId}/reconnect`, 'POST', viewerCookie)).status).toBe(403);
    });

    it('gives 404 for an unknown machine', async () => {
      expect((await request('/api/machine/nope/reconnect', 'POST')).status).toBe(404);
    });
  });
});
