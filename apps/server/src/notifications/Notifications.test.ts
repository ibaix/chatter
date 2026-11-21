import type { ChannelInput } from '@local-chatter/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Alert, AlertStore } from '../alerts/AlertStore.js';
import { SettingsTable } from '../storage/settingsTable.js';
import { Notifications } from './Notifications.js';
import { SEND_LIMIT } from './Outbox.js';

const NOW = Date.UTC(2026, 10, 13, 15, 2);

const slack: ChannelInput = {
  type: 'webhook', name: 'Slack', values: { url: 'https://hooks.slack.com/services/T0/B0/x' },
  minSeverity: 'warning', machineIds: null, enabled: true,
};

const alert: Alert = {
  name: 'In alarm', machineId: 'haas-vf2', labels: { alertname: 'In alarm', machine: 'haas-vf2', severity: 'critical' },
  annotations: {}, startsAt: NOW, endsAt: NOW + 60_000, resolved: false,
};

describe('Notifications', () => {
  let db: Database.Database;
  let alerts: AlertStore;
  let notifications: Notifications;
  let requests: { url: string; body: { text: string } }[];

  beforeEach(() => {
    db = new Database(':memory:');
    alerts = new AlertStore(db);
    requests = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as { text: string } });
      return new Response(null, { status: 200 });
    };
    notifications = new Notifications({
      db, settingsTable: new SettingsTable(db), machineName: () => 'Haas VF-2', now: () => NOW, fetch: fetch as typeof globalThis.fetch,
    });
    notifications.settings.save({ linkBaseUrl: null, timeZone: 'America/Chicago' });
  });

  function addChannel(input: ChannelInput): string {
    const result = notifications.channels.add(input, NOW);
    if (!result.ok) throw new Error(result.error);
    return result.channel.id;
  }

  it('sends a message to the webhook when an alert starts', async () => {
    addChannel(slack);
    alerts.save([alert], NOW);

    notifications.findAlertChanges();
    await notifications.sendDue();

    expect(requests).toEqual([{
      url: 'https://hooks.slack.com/services/T0/B0/x',
      body: expect.objectContaining({ text: 'CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.' }),
    }]);
    expect(notifications.outbox.list({})[0]).toMatchObject({ status: 'sent' });
  });

  describe('sendTest', () => {
    it('sends a test with the values of a form that is not saved', async () => {
      expect(await notifications.sendTest(slack)).toEqual({ ok: true, detail: expect.any(String) });
      expect(requests[0].body.text).toBe('Test from Chatter. Messages to this channel work.');
      expect(notifications.outbox.list({})).toEqual([]);
    });

    it('keeps the result of a test of a saved channel in its message list', async () => {
      const id = addChannel(slack);

      await notifications.sendTest(slack, id);

      expect(notifications.outbox.list({ channelId: id })).toEqual([expect.objectContaining({ kind: 'test', status: 'sent' })]);
    });

    it('tells why ntfy.sh refused a test, and does not say that Chatter tries again, because a test goes one time only', async () => {
      const quota = JSON.stringify({ code: 42908, http: 429, error: 'limit reached: daily message quota reached' });
      const fetch = async () => new Response(quota, { status: 429, headers: { 'retry-after': '3600' } });
      const withQuota = new Notifications({
        db, settingsTable: new SettingsTable(db), machineName: () => null, now: () => NOW, fetch: fetch as typeof globalThis.fetch,
      });
      const ntfy: ChannelInput = { ...slack, type: 'ntfy', name: 'Phones', values: { topic: 'chatter-test' } };

      expect(await withQuota.sendTest(ntfy)).toEqual({
        ok: false,
        error: 'ntfy.sh allows 250 messages each day for each network (IP address). The limit is used. '
          + 'It resets in 60 minutes. Use an access token or your own ntfy server.',
      });
    });

    it('gives the first problem of the form and sends nothing', async () => {
      expect(await notifications.sendTest({ ...slack, values: { url: 'not an address' } })).toEqual({ ok: false, error: expect.any(String) });
      expect(requests).toEqual([]);
    });
  });

  describe('ignore patterns', () => {
    it('never ignores a test, also when its text matches a pattern', async () => {
      const id = addChannel({ ...slack, ignorePatterns: ['Test from Chatter'] });

      expect(await notifications.sendTest({ ...slack, ignorePatterns: ['Test from Chatter'] }, id)).toMatchObject({ ok: true });

      expect(requests).toHaveLength(1);
      expect(notifications.outbox.list({ channelId: id })).toEqual([expect.objectContaining({ kind: 'test', status: 'sent' })]);
    });

    it('never ignores an "And N more" message, also when its text matches a pattern', async () => {
      const id = addChannel({ ...slack, ignorePatterns: ['more alerts'] });
      const many = Array.from({ length: SEND_LIMIT + 2 }, (_, index) => ({
        ...alert, name: `Alarm ${index}`, labels: { ...alert.labels, alertname: `Alarm ${index}` },
      }));
      alerts.save(many, NOW);
      notifications.findAlertChanges();

      for (let index = 0; index < SEND_LIMIT; index += 1) await notifications.sendDue();

      expect(requests).toHaveLength(SEND_LIMIT);
      expect(requests[SEND_LIMIT - 1].body.text).toMatch(/more alerts/);
      expect(notifications.outbox.list({ channelId: id }).filter(message => message.status === 'ignored')).toEqual([]);
    });
  });

  it('holds an ntfy channel until its daily limit resets, and then sends a summary and the newest messages, not each one', async () => {
    let now = NOW;
    const sent: string[] = [];
    let limited = true;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (limited) {
        return new Response(JSON.stringify({ code: 42908, http: 429, error: 'limit reached: daily message quota reached' }), {
          status: 429, headers: { 'retry-after': String(6 * 3600) },
        });
      }
      sent.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response('{"id":"x"}', { status: 200 });
    };
    const ntfy = new Notifications({
      db, settingsTable: new SettingsTable(db), machineName: () => 'Haas VF-2', now: () => now, fetch: fetch as typeof globalThis.fetch,
    });
    const added = ntfy.channels.add({ ...slack, type: 'ntfy', name: 'Phones', values: { topic: 'chatter-test' } }, NOW);
    if (!added.ok) throw new Error(added.error);
    const alarms = Array.from({ length: 12 }, (_, index) => ({
      ...alert, name: `Alarm ${index}`, labels: { ...alert.labels, alertname: `Alarm ${index}` },
    }));

    alerts.save(alarms.slice(0, 1), now);
    ntfy.findAlertChanges();
    await ntfy.sendDue();
    for (let hour = 1; hour < 6; hour += 1) {
      now = NOW + hour * 3_600_000;
      alerts.save(alarms.slice(0, hour * 2 + 2), now);
      ntfy.findAlertChanges();
      await ntfy.sendDue();
    }
    expect(sent).toEqual([]);

    limited = false;
    now = NOW + 6 * 3_600_000;
    for (let round = 0; round < 20; round += 1) await ntfy.sendDue();

    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatch(/^Chatter could not send 9 alerts while the channel was blocked: /);
    expect(sent.slice(1)).toEqual([
      expect.stringContaining('Alarm 9 '), expect.stringContaining('Alarm 10 '), expect.stringContaining('Alarm 11 '),
    ]);
  });

  it('ends the hold of an ntfy channel when the admin saves an access token, and then sends a summary and the newest messages', async () => {
    let now = NOW;
    const sent: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (!new Headers(init?.headers).has('authorization')) {
        return new Response(JSON.stringify({ code: 42908, http: 429, error: 'limit reached: daily message quota reached' }), {
          status: 429, headers: { 'retry-after': String(6 * 3600) },
        });
      }
      sent.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response('{"id":"x"}', { status: 200 });
    };
    const ntfy = new Notifications({
      db, settingsTable: new SettingsTable(db), machineName: () => 'Haas VF-2', now: () => now, fetch: fetch as typeof globalThis.fetch,
    });
    const input: ChannelInput = { ...slack, type: 'ntfy', name: 'Phones', values: { topic: 'chatter-test' } };
    const added = ntfy.channels.add(input, NOW);
    if (!added.ok) throw new Error(added.error);
    const alarms = Array.from({ length: 8 }, (_, index) => ({
      ...alert, name: `Alarm ${index}`, labels: { ...alert.labels, alertname: `Alarm ${index}` },
    }));
    alerts.save(alarms.slice(0, 1), now);
    ntfy.findAlertChanges();
    await ntfy.sendDue();
    now = NOW + 60_000;
    alerts.save(alarms, now);
    ntfy.findAlertChanges();
    await ntfy.sendDue();
    expect(sent).toEqual([]);

    now = NOW + 2 * 60_000;
    expect(ntfy.updateChannel(added.channel.id, { ...input, values: { topic: 'chatter-test', token: 'tk_new' } })).toMatchObject({ ok: true });
    for (let round = 0; round < 10; round += 1) await ntfy.sendDue();

    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatch(/^Chatter could not send 5 alerts while the channel was blocked: /);
    expect(sent.slice(1)).toEqual([
      expect.stringContaining('Alarm 5'), expect.stringContaining('Alarm 6'), expect.stringContaining('Alarm 7'),
    ]);
  });

  it('sends a "program ended" event of a machine at most one time in 15 minutes, with the count of the others', async () => {
    let now = NOW;
    const events = new Notifications({
      db, settingsTable: new SettingsTable(db), machineName: () => 'Haas VF-2', now: () => now,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as { text: string } });
        return new Response(null, { status: 200 });
      }) as typeof globalThis.fetch,
    });
    events.settings.save({ linkBaseUrl: null, timeZone: 'America/Chicago' });
    addChannel(slack);
    const labels = { alertname: 'Program ended', machine: 'haas-vf2', severity: 'warning', event: 'true' };

    // A short program: it ends each 45 seconds for one hour, so 80 events
    for (let second = 0; second < 3600; second += 45) {
      now = NOW + second * 1000;
      alerts.save([{ ...alert, name: 'Program ended', labels, startsAt: now, endsAt: now + 60_000 }], now);
      events.findAlertChanges();
      await events.sendDue();
    }

    expect(requests.map(request => request.body.text)).toEqual([
      'WARNING - Haas VF-2: Program ended. Started 9:02 AM.',
      'WARNING - Haas VF-2: Program ended. Started 9:17 AM. This happened 20 times since 9:02 AM.',
      'WARNING - Haas VF-2: Program ended. Started 9:32 AM. This happened 20 times since 9:17 AM.',
      'WARNING - Haas VF-2: Program ended. Started 9:47 AM. This happened 20 times since 9:32 AM.',
    ]);
  });

  it('deletes the waiting messages of a removed channel', () => {
    const id = addChannel(slack);
    alerts.save([alert], NOW);
    notifications.findAlertChanges();

    expect(notifications.removeChannel(id)).toBe(true);

    expect(notifications.outbox.list({})).toEqual([]);
    expect(notifications.channels.get(id)).toBeNull();
  });

  it('takes a removed machine out of the channels and deletes its waiting messages', () => {
    const id = addChannel({ ...slack, machineIds: ['haas-vf2', 'haas-st10'] });
    alerts.save([alert], NOW);
    notifications.findAlertChanges();

    notifications.removeMachine('haas-vf2');

    expect(notifications.outbox.list({})).toEqual([]);
    expect(notifications.channels.get(id)?.machineIds).toEqual(['haas-st10']);
  });

  it('stops all its timers', async () => {
    vi.useFakeTimers();
    try {
      notifications.start();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await notifications.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
