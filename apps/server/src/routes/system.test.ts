import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SESSION_COOKIE } from '../auth/authRoutes.js';
import { loggedInAuth } from '../auth/testSupport.js';
import type { Auth } from '../auth/Auth.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { UpdateFolder } from '../updates/UpdateFolder.js';
import { NO_REBOOT_MESSAGE, UpdateService } from '../updates/UpdateService.js';
import { offlineReleases } from '../updates/testSupport.js';
import type { SystemFacts } from './system.js';
import { errorOf, testApp } from './testSupport.js';

const NEW_HELPER = '{"arch":"armv7","capabilities":["reboot","network","log"]}';
const NETWORK = '{"hostname":"chatter","localName":"chatter.local","addresses":[{"interface":"eth0","address":"192.168.1.20/24"}],"gateway":"192.168.1.1","ssh":true,"updatedAt":"2026-11-21T10:00:00Z"}';

describe('system routes', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let cookie: string;
  let operatorCookie: string;
  let root: string;
  let inbox: string;
  let log: CapturedLog;
  let restartChatter: Mock<() => void>;

  beforeAll(async () => {
    ({ auth, accounts, cookie } = await loggedInAuth());
    const login = { username: 'operator', password: 'test-password' };
    await accounts.add({ ...login, role: 'operator' });
    operatorCookie = `${SESSION_COOKIE}=${await auth.logIn(login, { userAgent: 'test browser', address: '127.0.0.1' })}`;
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'system-routes-'));
    inbox = path.join(root, 'inbox');
    mkdirSync(inbox);
    log = captureLog();
    restartChatter = vi.fn<() => void>();
  });

  afterEach(() => {
    log.restore();
    rmSync(root, { recursive: true, force: true });
  });

  const app = (isInDocker = true) => testApp({
    auth, accounts, version: '1.2.0',
    updates: new UpdateService(new UpdateFolder(root), '1.2.0', offlineReleases()),
    system: { restartChatter, isInDocker },
  });
  const request = (pathName: string, method = 'GET', as = cookie, isInDocker = true) =>
    app(isInDocker).request(pathName, { method, headers: { Cookie: as } });

  it('only an admin can see the facts and restart', async () => {
    for (const [pathName, method] of [['/api/system/facts', 'GET'], ['/api/system/restart-chatter', 'POST'], ['/api/system/restart-pi', 'POST']]) {
      expect((await request(pathName, method, operatorCookie)).status, pathName).toBe(403);
    }
    expect(restartChatter).not.toHaveBeenCalled();
  });

  describe('GET /system/facts', () => {
    it('on a normal computer: no Pi, no network facts', async () => {
      const facts = await (await request('/api/system/facts', 'GET', cookie, false)).json() as SystemFacts;
      expect(facts).toMatchObject({ version: '1.2.0', canRestartChatter: false, canRestartPi: false, isPiCard: false, network: null });
      expect(Date.parse(facts.startedAt)).toBeLessThanOrEqual(Date.now());
    });

    it('on a card with a newer helper: the network facts, and the Pi restart', async () => {
      writeFileSync(path.join(root, 'helper.json'), NEW_HELPER);
      writeFileSync(path.join(root, 'network.json'), NETWORK);
      const facts = await (await request('/api/system/facts')).json() as SystemFacts;
      expect(facts).toMatchObject({ canRestartChatter: true, canRestartPi: true, isPiCard: true, network: JSON.parse(NETWORK) });
    });

    it('on a card with an older helper: no Pi restart and no network facts', async () => {
      writeFileSync(path.join(root, 'helper.json'), '{"arch":"armv7"}');
      const facts = await (await request('/api/system/facts')).json() as SystemFacts;
      expect(facts).toMatchObject({ canRestartPi: false, isPiCard: true, network: null });
    });
  });

  describe('POST /system/restart-chatter', () => {
    it('replies, restarts, and logs the user', async () => {
      const res = await request('/api/system/restart-chatter', 'POST');
      expect(res.status).toBe(202);
      expect(restartChatter).toHaveBeenCalledTimes(1);
      expect(log.text('warn')).toContain('Restart of Chatter asked user=admin');
    });

    it('refuses outside Docker, where nothing starts Chatter again', async () => {
      const res = await request('/api/system/restart-chatter', 'POST', cookie, false);
      expect(res.status).toBe(409);
      expect(restartChatter).not.toHaveBeenCalled();
    });
  });

  describe('POST /system/restart-pi', () => {
    it('writes a reboot request for a helper that can restart the Pi, and logs the user', async () => {
      writeFileSync(path.join(root, 'helper.json'), NEW_HELPER);
      const res = await request('/api/system/restart-pi', 'POST');
      expect(res.status).toBe(202);
      expect(readFileSync(path.join(inbox, 'request.json'), 'utf8')).toBe('reboot');
      expect(log.text('warn')).toContain('Restart of the Pi asked user=admin');
    });

    it('refuses with an older helper, and on a normal computer', async () => {
      writeFileSync(path.join(root, 'helper.json'), '{"arch":"armv7"}');
      const res = await request('/api/system/restart-pi', 'POST');
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe(NO_REBOOT_MESSAGE);
      rmSync(path.join(root, 'helper.json'));
      expect((await request('/api/system/restart-pi', 'POST')).status).toBe(409);
    });

    it('refuses while a request waits, or while the helper works', async () => {
      writeFileSync(path.join(root, 'helper.json'), NEW_HELPER);
      writeFileSync(path.join(inbox, 'request.json'), 'check');
      expect((await request('/api/system/restart-pi', 'POST')).status).toBe(409);
      rmSync(path.join(inbox, 'request.json'));
      writeFileSync(path.join(root, 'status.json'), JSON.stringify({ state: 'installing', heartbeat: new Date().toISOString(), freeBytes: 1 }));
      expect((await request('/api/system/restart-pi', 'POST')).status).toBe(409);
    });
  });

  describe('GET /updates/helper-log', () => {
    it('gives the lines that the helper wrote', async () => {
      writeFileSync(path.join(root, 'helper.log'), '2026-11-21T10:00:00Z [request] Step: copying.\n');
      const res = await request('/api/updates/helper-log');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('2026-11-21T10:00:00Z [request] Step: copying.\n');
    });

    it('gives 404 with an older helper', async () => {
      expect((await request('/api/updates/helper-log')).status).toBe(404);
    });
  });
});
