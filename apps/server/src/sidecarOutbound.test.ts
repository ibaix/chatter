import type { ChannelInput } from '@local-chatter/shared';
import { UPDATE_FILE_LIMIT_BYTES } from '@local-chatter/shared';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Alert, AlertStore } from './alerts/AlertStore.js';
import type { Auth } from './auth/Auth.js';
import { SESSION_COOKIE } from './auth/authRoutes.js';
import { loggedInAuth } from './auth/testSupport.js';
import type { UserAccounts } from './auth/userAccounts.js';
import { Notifications } from './notifications/Notifications.js';
import { OutboxSender } from './notifications/OutboxSender.js';
import { errorOf, testApp, type TestApp } from './routes/testSupport.js';
import {
  NOTIFICATION_OUTBOUND_ERROR,
  SIDECAR_OFF,
  SIDECAR_OUTBOUND_STATUS,
  UPDATE_OUTBOUND_ERROR,
  startOutboundNotifications,
  type SidecarFlags,
} from './sidecarConfig.js';
import { SettingsTable } from './storage/settingsTable.js';
import { memoryCheckSettingStore, ReleaseWatcher } from './updates/ReleaseWatcher.js';
import { UPDATE_FILE_NAME, UpdateFolder } from './updates/UpdateFolder.js';
import { UpdateService } from './updates/UpdateService.js';

const NOW = Date.UTC(2026, 10, 13, 15, 2);
const WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/x';
const ASSET_URL = 'https://github.com/toolpath/chatter/releases/download/v1.3.0/chatter-update-1.3.0-armv7.tar';
const RELEASE = {
  tag_name: 'v1.3.0',
  assets: [{ name: 'chatter-update-1.3.0-armv7.tar', size: 11, browser_download_url: ASSET_URL }],
};

const slack: ChannelInput = {
  type: 'webhook', name: 'Slack', values: { url: WEBHOOK_URL, secret: 'hook-secret' },
  minSeverity: 'warning', machineIds: null, enabled: true,
};

const alert: Alert = {
  name: 'In alarm', machineId: 'haas-vf2', labels: { alertname: 'In alarm', machine: 'haas-vf2', severity: 'critical' },
  annotations: {}, startsAt: NOW, endsAt: NOW + 60_000,
};

/** An update folder with enough free space for the test file */
class CardFolder extends UpdateFolder {
  override async freeBytes(): Promise<number> {
    return 10 * UPDATE_FILE_LIMIT_BYTES;
  }
}

describe('sidecar outbound calls', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let adminCookie: string;
  let viewerCookie: string;
  const roots: string[] = [];

  beforeAll(async () => {
    ({ auth, accounts, cookie: adminCookie } = await loggedInAuth());
    const viewer = { username: 'viewer', password: 'test-password' };
    await accounts.add({ ...viewer, role: 'viewer' });
    viewerCookie = `${SESSION_COOKIE}=${await auth.logIn(viewer, { userAgent: 'test browser', address: '127.0.0.1' })}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  describe('startup suppression', () => {
    /** A saved channel and a queued alert message, as an older chatter.db can hold */
    function queuedNotifications() {
      const calls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      });
      const db = new Database(':memory:');
      const alerts = new AlertStore(db);
      const notifications = new Notifications({
        db, settingsTable: new SettingsTable(db), machineName: () => 'Haas VF-2', now: () => NOW,
        fetch: fetch as typeof globalThis.fetch,
      });
      const added = notifications.channels.add(slack, NOW);
      if (!added.ok) throw new Error(added.error);
      alerts.save([alert], NOW);
      notifications.findAlertChanges();
      return { notifications, calls };
    }

    it('does not start OutboxSender when history is off, so a queued webhook stays unsent', async () => {
      const { notifications, calls } = queuedNotifications();
      const start = vi.spyOn(OutboxSender.prototype, 'start');
      try {
        expect(notifications.outbox.list({})).toEqual([expect.objectContaining({ status: 'waiting' })]);

        expect(startOutboundNotifications(notifications, { ...SIDECAR_OFF, disableHistory: true })).toBe(false);

        expect(start).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
        expect(notifications.outbox.list({})).toEqual([expect.objectContaining({ status: 'waiting' })]);
      } finally {
        start.mockRestore();
        await notifications.stop();
      }
    });

    it('starts OutboxSender when history is on, and the poll sends the queued webhook', async () => {
      const { notifications, calls } = queuedNotifications();
      const start = vi.spyOn(OutboxSender.prototype, 'start');
      try {
        expect(startOutboundNotifications(notifications, SIDECAR_OFF)).toBe(true);
        expect(start).toHaveBeenCalledOnce();
        // The sender calls sendDue on its timer. Call it once here, so the test does not wait for that timer.
        await notifications.sendDue();

        expect(calls).toEqual([WEBHOOK_URL]);
        expect(notifications.outbox.list({})[0]).toMatchObject({ status: 'sent' });
      } finally {
        start.mockRestore();
        await notifications.stop();
      }
    });
  });

  describe('update routes', () => {
    /** A watcher that already knows a newer release, and an app with the update check on or off */
    async function updateApp(flags: Partial<SidecarFlags> = {}) {
      const root = mkdtempSync(path.join(os.tmpdir(), 'sidecar-updates-'));
      roots.push(root);
      const inbox = path.join(root, 'inbox');
      mkdirSync(inbox);
      writeFileSync(path.join(root, 'helper.json'), '{"arch":"armv7"}');
      const calls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request) => {
        const address = String(url);
        calls.push(address);
        return address === ASSET_URL ? new Response('update file') : Response.json(RELEASE);
      });
      const releases = new ReleaseWatcher({
        repo: 'toolpath/chatter', store: memoryCheckSettingStore(), fetch: fetch as typeof globalThis.fetch,
      });
      await releases.checkNow();
      const updates = new UpdateService(new CardFolder(root), '1.2.0', releases);
      const app = testApp({
        auth, accounts, updates, sidecar: { ...SIDECAR_OFF, disableUpdateCheck: true, ...flags },
      });
      return { app, calls, inbox, updates };
    }

    function send(app: TestApp, cookie: string, method: string, path: string, body?: unknown) {
      return app.request(path, {
        method,
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    async function newest(app: TestApp) {
      const res = await send(app, adminCookie, 'GET', '/api/updates/status');
      return (await res.json()) as { newest: { checkGitHub: boolean } };
    }

    it('refuses a GitHub download and a change of the GitHub check, and calls GitHub no further', async () => {
      const { app, calls, inbox, updates } = await updateApp();
      const download = vi.spyOn(updates, 'download');
      const setCheckGitHub = vi.spyOn(updates, 'setCheckGitHub');
      const afterCheck = calls.length;

      const downloaded = await send(app, adminCookie, 'POST', '/api/updates/download');
      const turnedOff = await send(app, adminCookie, 'PUT', '/api/updates/settings', { checkGitHub: false });
      const turnedOn = await send(app, adminCookie, 'PUT', '/api/updates/settings', { checkGitHub: true });

      expect(downloaded.status).toBe(SIDECAR_OUTBOUND_STATUS);
      expect(await errorOf(downloaded)).toBe(UPDATE_OUTBOUND_ERROR);
      expect(turnedOff.status).toBe(SIDECAR_OUTBOUND_STATUS);
      expect(await errorOf(turnedOff)).toBe(UPDATE_OUTBOUND_ERROR);
      expect(turnedOn.status).toBe(SIDECAR_OUTBOUND_STATUS);
      expect(await errorOf(turnedOn)).toBe(UPDATE_OUTBOUND_ERROR);
      expect(download).not.toHaveBeenCalled();
      expect(setCheckGitHub).not.toHaveBeenCalled();
      expect(calls).toHaveLength(afterCheck);
      expect(calls).not.toContain(ASSET_URL);
      expect(readdirSync(inbox)).toEqual([]);
      expect((await newest(app)).newest.checkGitHub).toBe(true);
    });

    it('still reads the update status and still asks the helper to check a local file', async () => {
      const { app } = await updateApp();

      expect((await send(app, adminCookie, 'GET', '/api/updates/status')).status).toBe(200);

      const check = await send(app, adminCookie, 'POST', '/api/updates/check');

      expect(check.status).toBe(409);
      expect(await errorOf(check)).toContain('Upload or download an update file first');
    });

    it('still needs a login, and a viewer still gets 403', async () => {
      const { app } = await updateApp();

      expect((await app.request('/api/updates/download', { method: 'POST' })).status).toBe(401);
      expect((await send(app, viewerCookie, 'POST', '/api/updates/download')).status).toBe(403);
      expect((await send(app, viewerCookie, 'PUT', '/api/updates/settings', { checkGitHub: true })).status).toBe(403);
    });

    it('still changes the GitHub check when only history is off', async () => {
      const { app } = await updateApp({ disableUpdateCheck: false, disableHistory: true });

      const res = await send(app, adminCookie, 'PUT', '/api/updates/settings', { checkGitHub: false });

      expect(res.status).toBe(200);
      expect((await newest(app)).newest.checkGitHub).toBe(false);
    });

    it('downloads the release when the update check is on', async () => {
      const { app, calls, inbox } = await updateApp({ disableUpdateCheck: false });

      const res = await send(app, adminCookie, 'POST', '/api/updates/download');

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(calls).toContain(ASSET_URL);
        expect(readdirSync(inbox)).toEqual([UPDATE_FILE_NAME]);
      });
    });
  });

  describe('notification routes', () => {
    function notificationApp(flags: Partial<SidecarFlags> = {}) {
      const calls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      });
      const db = new Database(':memory:');
      new AlertStore(db);
      const notifications = new Notifications({
        db, settingsTable: new SettingsTable(db), machineName: () => null, fetch: fetch as typeof globalThis.fetch,
      });
      const app = testApp({
        auth, accounts, notifications, sidecar: { ...SIDECAR_OFF, disableHistory: true, ...flags },
      });
      return { app, calls, notifications };
    }

    function send(app: TestApp, cookie: string, method: string, path: string, body?: unknown) {
      return app.request(path, {
        method,
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    it('refuses a test and a channel change, and sends nothing', async () => {
      const { app, calls, notifications } = notificationApp();
      const routes: Array<[string, string, unknown?]> = [
        ['POST', '/api/notification-channels', slack],
        ['POST', '/api/notification-channels/test', slack],
        ['PUT', '/api/notification-channels/missing', slack],
        ['DELETE', '/api/notification-channels/missing'],
        ['POST', '/api/notification-channels/missing/test', slack],
      ];

      for (const [method, path, body] of routes) {
        const res = await send(app, adminCookie, method, path, body);
        expect([method, path, res.status, await errorOf(res)]).toEqual([method, path, SIDECAR_OUTBOUND_STATUS, NOTIFICATION_OUTBOUND_ERROR]);
      }

      expect(calls).toEqual([]);
      expect(notifications.channels.list()).toEqual([]);
      expect((await send(app, adminCookie, 'GET', '/api/notification-channels')).status).toBe(200);
      expect((await send(app, adminCookie, 'PUT', '/api/notification-settings', { linkBaseUrl: null, timeZone: null })).status).toBe(200);
    });

    it('still needs a login, and a viewer still gets 403', async () => {
      const { app, calls } = notificationApp();

      expect((await app.request('/api/notification-channels/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slack),
      })).status).toBe(401);
      expect((await send(app, viewerCookie, 'POST', '/api/notification-channels', slack)).status).toBe(403);
      expect((await send(app, viewerCookie, 'POST', '/api/notification-channels/test', slack)).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it('sends a test when history is on', async () => {
      const { app, calls } = notificationApp({ disableHistory: false });

      const res = await send(app, adminCookie, 'POST', '/api/notification-channels/test', slack);

      expect(res.status).toBe(200);
      expect(calls).toEqual([WEBHOOK_URL]);
    });

    it('still sends a test when only the update check is off', async () => {
      const { app, calls } = notificationApp({ disableHistory: false, disableUpdateCheck: true });

      const res = await send(app, adminCookie, 'POST', '/api/notification-channels/test', slack);

      expect(res.status).toBe(200);
      expect(calls).toEqual([WEBHOOK_URL]);
    });
  });
});
