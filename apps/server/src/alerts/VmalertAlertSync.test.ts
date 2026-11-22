import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { type Alert, AlertStore, VMALERT_LEASE_MS } from './AlertStore.js';
import { MAX_RULES_REPLY_BYTES, SYNC_INTERVAL_MS, VmalertAlertSync } from './VmalertAlertSync.js';

const NOW = Date.UTC(2026, 11, 21, 22, 12);
const MINUTE_MS = 60_000;

const firingLabels = {
  alertgroup: 'machine-m1', alertname: 'In alarm', machine: 'm1', rule_id: 'r1', severity: 'critical', type: 'brother',
};
const goneLabels = { ...firingLabels, alertname: 'Emergency stop', rule_id: 'r2' };

/** The reply of GET /api/v1/rules?type=alert, as captured from vmalert v1.155.0, with fewer fields */
function vmalertReply(lastEvaluation = new Date(NOW - 10_000).toISOString()) {
  const rule = (name: string, alerts: unknown[]) => ({
    state: alerts.length > 0 ? 'firing' : 'inactive', name, query: 'chatter_alarm{machine="m1"} == 1', duration: 0,
    labels: { machine: 'm1', severity: 'critical' }, lastError: '', lastEvaluation, alerts, health: 'ok', type: 'alerting',
    group_name: 'machine-m1',
  });
  return {
    status: 'success',
    data: {
      groups: [{
        name: 'machine-m1', interval: 15, lastEvaluation, type: 'prometheus',
        rules: [
          rule('In alarm', [{
            state: 'firing', name: 'In alarm', value: '1', labels: firingLabels, annotations: { summary: 'In alarm' },
            activeAt: '2026-12-21T22:10:30Z', id: '17184007065547556933', restored: false, stabilizing: false,
          }]),
          rule('Emergency stop', []),
        ],
      }],
    },
  };
}

/** Sent last 2 minutes ago, so the end time passed while Chatter was off */
function lapsedAlert(labels: Record<string, string>): Alert {
  return {
    name: labels.alertname, machineId: 'm1', labels, annotations: {},
    startsAt: NOW - 5 * MINUTE_MS, endsAt: NOW - 2 * MINUTE_MS + VMALERT_LEASE_MS, resolved: false,
  };
}

const allAlertsQuery = { now: NOW, firingOnly: false, endedAfter: 0, limit: 100 };

describe('VmalertAlertSync', () => {
  let store: AlertStore;
  let log: CapturedLog;
  let requests: { url: string; init: RequestInit }[];
  let syncCount: number;

  function syncWith(answer: () => Response | Promise<Response>, afterSync = () => { syncCount++; }) {
    const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      return answer();
    }) as typeof globalThis.fetch;
    return new VmalertAlertSync({ url: 'http://vmalert:8880', store, fetch, now: () => NOW, afterSync });
  }

  beforeEach(() => {
    store = AlertStore.inMemory();
    store.save([lapsedAlert(firingLabels), lapsedAlert(goneLabels)], NOW - 2 * MINUTE_MS);
    log = captureLog();
    requests = [];
    syncCount = 0;
  });

  afterEach(() => {
    log.restore();
    vi.useRealTimers();
  });

  it('syncs at the start and then every 2 minutes, until it stops', async () => {
    vi.useFakeTimers();
    const sync = syncWith(() => Response.json(vmalertReply()));

    sync.start();
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(requests).toHaveLength(2);

    sync.stop();
    await vi.advanceTimersByTimeAsync(2 * SYNC_INTERVAL_MS);
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['the alert store fails', () => {
      vi.spyOn(store, 'updateFromVmalert').mockImplementation(() => { throw new Error('database is locked'); });
      return syncWith(() => Response.json(vmalertReply()));
    }],
    ['the search for the alert changes fails', () => syncWith(() => Response.json(vmalertReply()), () => { throw new Error('database is locked'); })],
  ])('writes an error in the log and does not throw when %s', async (_name, makeSync) => {
    const sync = makeSync();

    await expect(sync.syncNow()).resolves.toBe(false);

    expect(log.text('error')).toContain('Could not update the alerts from vmalert');
    expect(log.text('error')).toContain('database is locked');
  });

  it('renews the alerts that still fire in vmalert, resolves the alerts that are gone, and then finds the changes', async () => {
    const sync = syncWith(() => Response.json(vmalertReply()));

    expect(await sync.syncNow()).toBe(true);

    expect(requests.map(request => request.url)).toEqual(['http://vmalert:8880/api/v1/rules?type=alert']);
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(store.read(allAlertsQuery).map(({ name, endsAt, resolved }) => ({ name, endsAt, resolved }))).toEqual([
      { name: 'Emergency stop', endsAt: NOW - MINUTE_MS, resolved: true },
      { name: 'In alarm', endsAt: NOW + VMALERT_LEASE_MS, resolved: false },
    ]);
    expect(syncCount).toBe(1);
    expect(log.text('info')).toContain('renewed=1 ended=1');
  });

  it('resolves nothing when vmalert has not checked the rules since the last send, for example just after its start', async () => {
    const sync = syncWith(() => Response.json(vmalertReply('0001-01-01T00:00:00Z')));

    await sync.syncNow();

    expect(store.read(allAlertsQuery).map(found => found.resolved)).toEqual([false, false]);
  });

  it.each([
    ['vmalert does not answer', () => Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }))],
    ['vmalert answers with an error', () => new Response('no', { status: 503 })],
    ['the reply is not JSON', () => new Response('{not json')],
    ['the reply has another shape', () => Response.json({ data: { groups: 'none' } })],
    ['the reply is too large', () => new Response('x'.repeat(MAX_RULES_REPLY_BYTES + 1))],
  ])('changes nothing when %s, and tries again later', async (_name, answer) => {
    const sync = syncWith(answer);

    expect(await sync.syncNow()).toBe(false);

    expect(store.read(allAlertsQuery).map(found => found.endsAt)).toEqual([NOW - MINUTE_MS, NOW - MINUTE_MS]);
    expect(syncCount).toBe(0);
    expect(log.text('warn')).toContain('Could not read the alerts of vmalert');
  });

  it('writes the same problem in the log one time only, and tells when it works again', async () => {
    let answer = () => new Response('no', { status: 503 });
    const sync = syncWith(() => answer());

    await sync.syncNow();
    await sync.syncNow();
    answer = () => Response.json(vmalertReply());
    await sync.syncNow();

    expect(log.lines.filter(line => line.level === 'warn')).toHaveLength(1);
    expect(log.text('info')).toContain('Reading the alerts of vmalert works again');
  });
});
