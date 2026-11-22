import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { NewAlertRule } from '@local-chatter/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertRuleService } from '../alert-rules/AlertRuleService.js';
import { AlertRuleStore } from '../alert-rules/AlertRuleStore.js';
import type { Auth } from '../auth/Auth.js';
import { SESSION_COOKIE } from '../auth/authRoutes.js';
import { loggedInAuth } from '../auth/testSupport.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { unpack } from '../history-backup/archiveTestSupport.js';
import { HistoryBackup } from '../history-backup/HistoryBackup.js';
import { sampleFacts, textLines } from '../history-backup/relabel.js';
import { addHistory, FakeVictoria, holdImports } from '../history-backup/testSupport.js';
import { HistoryUnavailableError, VictoriaHistory, type HistoryStore } from '../history-backup/victoriaHistory.js';
import { MetricsReader, type HistorySource } from '../recording/MetricsReader.js';
import { captureLog } from '../logging/testSupport.js';
import { HardwarePoller } from '../polling/poller.js';
import { StatePeriodStore } from '../recording/StatePeriodStore.js';
import { applySchema } from '../storage/schema.js';
import { STREAM_STOPPED_TEXT } from './streamReplies.js';
import { testApp, type TestApp } from './testSupport.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The secrets of the test machines. None of them may be anywhere in a backup. */
const SECRETS = ['ftp-secret-1', 'ftp-user-2', 'macro-name-3', 'opcua-secret-4', '10.0.0.5', '10.0.0.6'];
const highLoad: NewAlertRule = {
  kind: 'simple', enabled: true, subject: 'spindle-load', check: 'above', limit: 90, forMinutes: 1, severity: 'warning',
};

/** Where the history is: the fake, or a real VictoriaMetrics (see victoriaHistory.test.ts) */
interface Backend {
  history: HistorySource;
  store: HistoryStore;
  seed(machineId: string, from: number, to: number): Promise<void>;
  /** The listener that deletes the history of a removed machine has ended */
  afterRemove(machineId: string): Promise<void>;
  sampleCount(machineId: string): Promise<number>;
  /** New samples can be read */
  settle(): Promise<void>;
}

function fakeBackend(): Backend {
  const victoria = new FakeVictoria();
  return {
    history: victoria,
    store: victoria,
    seed: async (id, from, to) => addHistory(victoria, { id, type: 'brother' }, from, to),
    afterRemove: async id => victoria.removeMachine(id),
    sampleCount: async id => victoria.samplesOf(id).length,
    settle: async () => {},
  };
}

function realBackend(url: string): Backend {
  const store = new VictoriaHistory(url);
  const settle = async () => {
    await fetch(`${url}/internal/force_flush`);
    await store.importDone();
  };
  return {
    history: new MetricsReader({ url }),
    store,
    seed: async (id, from, to) => {
      const fake = new FakeVictoria();
      addHistory(fake, { id, type: 'brother' }, from, to);
      const lines: string[] = [];
      for await (const line of textLines(await fake.exportSeries(id, 'chatter_.*', { from: null, to }), 1024 * 1024)) lines.push(line);
      await store.importLines(lines.join('\n'));
      await settle();
    },
    afterRemove: async id => {
      await fetch(`${url}/api/v1/admin/tsdb/delete_series`, { method: 'POST', body: new URLSearchParams({ 'match[]': `{machine="${id}"}` }) });
    },
    sampleCount: async id => {
      await settle();
      let count = 0;
      const exported = await store.exportSeries(id, 'chatter_.*', { from: null, to: Date.now() }, new AbortController().signal);
      for await (const line of textLines(exported, 1024 * 1024)) count += sampleFacts(line).samples;
      return count;
    },
    settle,
  };
}

const REAL_URL = process.env.CHATTER_TEST_VICTORIA_URL;
const BACKENDS: [string, () => Backend][] = [['fake', fakeBackend], ...(REAL_URL ? [['real', () => realBackend(REAL_URL)] as [string, () => Backend]] : [])];

describe.each(BACKENDS)('history backup routes (%s VictoriaMetrics)', (_name, makeBackend) => {
  let auth: Auth;
  let accounts: UserAccounts;
  const cookies: Record<'admin' | 'operator' | 'viewer', string> = { admin: '', operator: '', viewer: '' };

  beforeAll(async () => {
    const logged = await loggedInAuth();
    ({ auth, accounts } = logged);
    cookies.admin = logged.cookie;
    for (const role of ['operator', 'viewer'] as const) {
      const login = { username: role, password: 'test-password' };
      await accounts.add({ ...login, role });
      cookies[role] = `${SESSION_COOKIE}=${await auth.logIn(login, { userAgent: 'test browser', address: '127.0.0.1' })}`;
    }
  });

  let folder: string;
  let backend: Backend;
  let periods: StatePeriodStore;
  let rules: AlertRuleService;
  let poller: HardwarePoller;
  let app: TestApp;
  let machineId: string;
  let now: number;

  beforeEach(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'history-backup-routes-'));
    const db = new Database(':memory:');
    applySchema(db);
    poller = new HardwarePoller(db);
    backend = makeBackend();
    // One database, as in index.ts, so the periods and the rules are restored in one transaction
    periods = new StatePeriodStore(db);
    rules = new AlertRuleService({
      store: new AlertRuleStore(db), rulesFile: { write: async () => {} }, vmalert: { reload: async () => true },
      queries: { check: async () => ({ ok: true, resultCount: 0, firstValue: null }) },
    });
    // What index.ts does when a machine is removed: its history, periods and rules go
    poller.addRemovalListener(rules);
    poller.addRemovalListener({ removeMachine: id => periods.removeMachine(id) });
    poller.addAddListener(rules);
    const historyBackup = new HistoryBackup({
      folder: path.join(folder, 'history-backup'), history: backend.store, statePeriods: periods, alertRules: rules, version: '1.4.0',
      freeBytes: async () => 100 * 1024 ** 3,
      // Small batches, so a restore sends more than one import request
      importBatchBytes: 100_000,
    });
    app = testApp({ auth, accounts, poller, history: backend.history, statePeriods: periods, alertRules: rules, historyBackup });

    const machine = await poller.addMachine({
      type: 'brother', name: 'Speedio', host: '10.0.0.5', ftpUser: 'ftp-user-2', ftpPassword: 'ftp-secret-1',
      macros: [{ location: 100, name: 'macro-name-3' }],
    });
    await poller.addMachine({ type: 'siemens', name: 'DMU', host: '10.0.0.6', opcuaUser: 'op', opcuaPassword: 'opcua-secret-4' });
    machineId = machine.id;
    now = Date.now();
    const start = Math.floor(now / MINUTE) * MINUTE - 5 * HOUR;
    await backend.seed(machineId, start, start + 3 * HOUR);
    periods.open(machineId, 'program', 'O1000', start);
    periods.open(machineId, 'alarm', '1234 SPINDLE OVERLOAD', start + HOUR);
    periods.close(machineId, 'alarm', start + HOUR + 5 * MINUTE);
    periods.close(machineId, 'program', start + 2 * HOUR);
    periods.open(machineId, 'program', 'O2000', start + 2 * HOUR);
    periods.close(machineId, 'program', start + 3 * HOUR);
    rules.replaceWithoutPublish(machineId, [highLoad]);
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const request = (method: string, address: string, role: keyof typeof cookies, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api${address}`, {
      method,
      headers: { Cookie: cookies[role], ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body),
    });

  async function backUp(id = machineId, options: Record<string, unknown> = {}): Promise<Buffer> {
    const prepared = await request('POST', `/machine/${id}/history-backup`, 'admin', options);
    expect(prepared.status).toBe(200);
    const { id: backupId, fileName } = await prepared.json() as { id: string; fileName: string };
    expect(fileName).toMatch(/^chatter-history-Speedio-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
    const download = await request('GET', `/machine/${id}/history-backup/${backupId}`, 'admin');
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toBe(`attachment; filename="${fileName}"`);
    return Buffer.from(await download.arrayBuffer());
  }

  function uploadTo(id: string, archive: Buffer, role: keyof typeof cookies = 'admin') {
    return request('POST', `/machine/${id}/history-restore`, role, new Uint8Array(archive), {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(archive.length),
    });
  }

  async function restore(id: string, archive: Buffer, alertRules = true) {
    const preview = await uploadTo(id, archive);
    expect(preview.status).toBe(200);
    const { id: restoreId } = await preview.json() as { id: string };
    const done = await request('POST', `/machine/${id}/history-restore/${restoreId}`, 'admin', { alertRules });
    expect(done.status).toBe(200);
    return done.json();
  }

  /** What the user sees of the history of a machine: the report, a chart, the periods and the state timeline */
  async function whatUserSees(id: string) {
    await backend.settle();
    const end = new Date(Math.floor(now / MINUTE) * MINUTE).toISOString();
    const read = async (address: string) => {
      const res = await request('GET', `/machine/${id}${address}`, 'viewer');
      expect(res.status).toBe(200);
      const { machineId: _id, ...rest } = await res.json() as Record<string, unknown>;
      return rest;
    };
    const report = await read('/report?range=-1d');
    return {
      report: { ...report, from: undefined, to: undefined },
      chart: await read(`/history/spindle-speed?range=-6h&window=5m&end=${end}`),
      parts: await read(`/history/part-count?range=-6h&window=1h&end=${end}`),
      periods: await read('/periods?range=-1d'),
      timeline: await read(`/state-timeline?range=-6h&end=${end}`),
    };
  }

  describe('roles', () => {
    it('a viewer and an operator cannot back up or restore', async () => {
      for (const role of ['viewer', 'operator'] as const) {
        expect((await request('POST', `/machine/${machineId}/history-backup`, role, {})).status).toBe(403);
        expect((await request('GET', `/machine/${machineId}/history-backup/x`, role)).status).toBe(403);
        expect((await uploadTo(machineId, Buffer.from('x'), role)).status).toBe(403);
        expect((await request('POST', `/machine/${machineId}/history-restore/x`, role, { alertRules: true })).status).toBe(403);
        expect((await request('DELETE', `/machine/${machineId}/history-restore/x`, role)).status).toBe(403);
      }
    });

    it('an admin can, and the log names the user', async () => {
      const log = captureLog();
      await restore(machineId, await backUp());
      log.restore();
      expect(log.text('info')).toMatch(/History backup made.*user=admin/);
      expect(log.text('info')).toMatch(/History restored.*user=admin/);
    });
  });

  it('gives 404 for a machine that is not there', async () => {
    expect((await request('POST', '/machine/nope/history-backup', 'admin', {})).status).toBe(404);
    expect((await uploadTo('nope', Buffer.from('x'))).status).toBe(404);
  });

  it('checks the request: a time range with the start before the end, and a raw file with its length', async () => {
    const backward = await request('POST', `/machine/${machineId}/history-backup`, 'admin', { from: now, to: now - HOUR });
    expect(backward.status).toBe(400);
    const asForm = await request('POST', `/machine/${machineId}/history-restore`, 'admin', new Uint8Array([1]), { 'Content-Type': 'text/plain' });
    expect(asForm.status).toBe(415);
    const notAnArchive = await uploadTo(machineId, Buffer.from('x'));
    expect(notAnArchive.status).toBe(400);
  });

  it('gives the file a safe name in Content-Disposition, also for a machine name with a quote, a slash or other letters', async () => {
    const added = await request('POST', '/machines', 'admin', { type: 'brother', name: 'Fräs/"Halle" 東京', host: '10.0.0.8' });
    const id = (await added.json() as { id: string }).id;
    const prepared = await request('POST', `/machine/${id}/history-backup`, 'admin', {});
    const { id: backupId, fileName } = await prepared.json() as { id: string; fileName: string };
    expect(fileName).toMatch(/^chatter-history-Fras-Halle-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
    const download = await request('GET', `/machine/${id}/history-backup/${backupId}`, 'admin');
    expect(download.headers.get('Content-Disposition')).toBe(`attachment; filename="${fileName}"`);
    await download.arrayBuffer();
  });

  it('has no secret of a machine in the file: no address, user, password or macro', async () => {
    const entries = await unpack(await backUp());
    const everything = [...entries].map(([name, data]) => (name.endsWith('.gz') ? gunzipSync(data) : data).toString('utf8')).join('\n');
    for (const secret of SECRETS) expect(everything, secret).not.toContain(secret);
    expect(JSON.parse(entries.get('manifest.json')!.toString()).machine).toEqual({ id: machineId, name: 'Speedio', type: 'brother' });
  });

  it('back up, remove the machine, add it again, restore: the user sees the same history, also after a second restore', async () => {
    const before = await whatUserSees(machineId);
    expect(before.report).toMatchObject({ partsMade: expect.any(Number) });
    expect((before.chart as { data: unknown[] }).data.length).toBeGreaterThan(10);
    const archive = await backUp();

    expect((await request('DELETE', `/machine/${machineId}`, 'admin')).status).toBe(200);
    await backend.afterRemove(machineId);
    expect(await backend.sampleCount(machineId)).toBe(0);
    const added = await request('POST', '/machines', 'admin', { type: 'brother', name: 'Speedio', host: '10.0.0.5' });
    const newId = (await added.json() as { id: string }).id;
    expect(newId).not.toBe(machineId);
    expect((await whatUserSees(newId)).periods).toMatchObject({ data: [] });

    expect(await restore(newId, archive)).toMatchObject({ periodsAdded: 3, periodsKnown: 0, alertRules: 1 });
    expect(await whatUserSees(newId)).toEqual(before);
    expect(rules.rulesOf(newId)).toEqual([{ ...highLoad, id: expect.any(String) }]);

    expect(await restore(newId, archive)).toMatchObject({ periodsAdded: 0, periodsKnown: 3 });
    expect(await whatUserSees(newId)).toEqual(before);
    expect(rules.rulesOf(newId)).toHaveLength(1);
  });

  it('shows a preview of the file before the restore, and writes nothing until the user confirms', async () => {
    const archive = await backUp();
    const other = await request('POST', '/machines', 'admin', { type: 'brother', name: 'Speedio 2', host: '10.0.0.7' });
    const otherId = (await other.json() as { id: string }).id;

    const preview = await uploadTo(otherId, archive);
    expect(await preview.json()).toMatchObject({
      source: { id: machineId, name: 'Speedio', type: 'brother' }, sameMachine: false,
      counts: { rawSamples: 4 * 5400, periods: 3, alertRules: 1 },
    });
    expect(await backend.sampleCount(otherId)).toBe(0);
    expect((await request('DELETE', `/machine/${otherId}/history-restore/${(await (await uploadTo(otherId, archive)).json() as { id: string }).id}`, 'admin')).status)
      .toBe(200);
  });

  it('refuses a file of another machine type', async () => {
    const archive = await backUp();
    const siemens = poller.getMachines().find(machine => machine.type === 'siemens')!;
    const res = await uploadTo(siemens.id, archive);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/type brother.*type siemens/) });
  });

  it('cancels a restore file only for its machine, and not while its restore runs', async () => {
    const archive = await backUp();
    const { id: restoreId } = await (await uploadTo(machineId, archive)).json() as { id: string };
    const other = poller.getMachines().find(machine => machine.id !== machineId)!;
    expect((await request('DELETE', `/machine/${other.id}/history-restore/${restoreId}`, 'admin')).status).toBe(404);

    const held = holdImports(backend.store);
    const running = request('POST', `/machine/${machineId}/history-restore/${restoreId}`, 'admin', { alertRules: false });
    await held.started;
    const cancel = await request('DELETE', `/machine/${machineId}/history-restore/${restoreId}`, 'admin');
    expect(cancel.status).toBe(409);
    held.release();
    expect((await running).status).toBe(200);
    expect((await request('DELETE', `/machine/${machineId}/history-restore/${restoreId}`, 'admin')).status).toBe(404);
  });

  describe('the reason of a failure', () => {
    const failExport = (error: Error) => {
      backend.store.exportSeries = async () => {
        throw error;
      };
    };

    it('gives 503 when VictoriaMetrics does not answer', async () => {
      failExport(new HistoryUnavailableError('VictoriaMetrics did not answer'));
      const res = await request('POST', `/machine/${machineId}/history-backup`, 'admin', {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/history database \(VictoriaMetrics\) does not answer/) });
    });

    it('gives 507 when the disk is full', async () => {
      failExport(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      const res = await request('POST', `/machine/${machineId}/history-backup`, 'admin', {});
      expect(res.status).toBe(507);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/disk of Chatter is full/) });
    });

    it('gives 400 for a restore file that is not correct', async () => {
      const res = await uploadTo(machineId, Buffer.from('not a backup'));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/not a .tar.gz/) });
    });

    it('logs an error in the middle of the download, and does not send its text or its path', async () => {
      const localError = "ENOENT: no such file or directory, open '/app/data/history-backup/part-1.jsonl.gz'";
      const download = vi.spyOn(HistoryBackup.prototype, 'download').mockReturnValue({
        fileName: 'chatter-history-Speedio.tar.gz',
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x1f, 0x8b]));
            controller.error(new Error(localError));
          },
        }),
      });
      const log = captureLog();

      const res = await request('GET', `/machine/${machineId}/history-backup/any`, 'admin');
      const failure = await res.arrayBuffer().then(() => null, (error: Error) => error);
      log.restore();
      download.mockRestore();

      expect(res.status).toBe(200);
      expect(failure?.message).toBe(STREAM_STOPPED_TEXT);
      expect(log.lines.filter(line => line.level === 'error')).toHaveLength(1);
      expect(log.text('error')).toContain(localError);
    });

    it('gives 500 for an error that Chatter does not expect, and logs it', async () => {
      failExport(new Error('a bug'));
      const log = captureLog();
      const res = await request('POST', `/machine/${machineId}/history-backup`, 'admin', {});
      log.restore();
      expect(res.status).toBe(500);
      expect(log.text('error')).toMatch(/History backup or restore failed.*a bug/);
      // The place is free again
      backend.store.exportSeries = makeBackend().store.exportSeries;
    });
  });

  it('when VictoriaMetrics fails during a restore, writes no period and no rule, and a new try doubles nothing', async () => {
    const archive = await backUp();
    const added = await request('POST', '/machines', 'admin', { type: 'brother', name: 'Speedio 2', host: '10.0.0.7' });
    const newId = (await added.json() as { id: string }).id;
    const { id: restoreId } = await (await uploadTo(newId, archive)).json() as { id: string };
    const importLines = backend.store.importLines.bind(backend.store);
    let calls = 0;
    backend.store.importLines = async body => {
      calls += 1;
      if (calls > 1) throw new HistoryUnavailableError('VictoriaMetrics answered 503: busy');
      return importLines(body);
    };
    const publish = vi.spyOn(rules, 'publish');
    const rulesBefore = rules.rulesOf(newId);

    const failed = await request('POST', `/machine/${newId}/history-restore/${restoreId}`, 'admin', { alertRules: true });
    expect(failed.status).toBe(503);
    expect(calls).toBe(2);
    expect(periods.read({ machineId: newId, from: 0, to: Date.now(), limit: 10 })).toEqual([]);
    expect(rules.rulesOf(newId)).toEqual(rulesBefore);
    expect(publish).not.toHaveBeenCalled();

    backend.store.importLines = importLines;
    const done = await request('POST', `/machine/${newId}/history-restore/${restoreId}`, 'admin', { alertRules: true });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ periodsAdded: 3, alertRules: 1 });
    expect(publish).toHaveBeenCalledOnce();
    expect(await backend.sampleCount(newId)).toBe(await backend.sampleCount(machineId));
  });

  it('gives 409 while the backup of another machine waits for its download, and a new backup of the same machine replaces it', async () => {
    const first = await request('POST', `/machine/${machineId}/history-backup`, 'admin', {});
    const { id: firstId } = await first.json() as { id: string };
    const other = poller.getMachines().find(machine => machine.id !== machineId)!;
    expect((await request('POST', `/machine/${other.id}/history-backup`, 'admin', {})).status).toBe(409);
    const second = await request('POST', `/machine/${machineId}/history-backup`, 'admin', {});
    expect(second.status).toBe(200);
    expect((await request('GET', `/machine/${machineId}/history-backup/${firstId}`, 'admin')).status).toBe(404);
  });

  it('stops a backup when the request stops, so the next backup can run', async () => {
    const exportSeries = backend.store.exportSeries.bind(backend.store);
    let started = () => {};
    const exportStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    // The export waits until its signal stops it
    backend.store.exportSeries = async (...args) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        args[3].addEventListener('abort', () => reject(args[3].reason), { once: true });
      });
      return exportSeries(...args);
    };
    const stop = new AbortController();
    const first = app.request(`/api/machine/${machineId}/history-backup`, {
      method: 'POST', headers: { Cookie: cookies.admin, 'Content-Type': 'application/json' }, body: '{}', signal: stop.signal,
    });
    await exportStarted;
    stop.abort(new Error('The proxy stopped waiting'));
    await Promise.resolve(first).catch(() => null);
    backend.store.exportSeries = exportSeries;
    const other = poller.getMachines().find(machine => machine.id !== machineId)!;
    expect((await request('POST', `/machine/${other.id}/history-backup`, 'admin', {})).status).toBe(200);
  });
});
