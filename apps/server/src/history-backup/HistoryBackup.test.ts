import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { NewAlertRule } from '@local-chatter/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertRuleService } from '../alert-rules/AlertRuleService.js';
import { captureLog } from '../logging/testSupport.js';
import { StatePeriodStore } from '../recording/StatePeriodStore.js';
import { ARCHIVE_LIMITS, FORMAT_VERSION, type Manifest } from './archive.js';
import { changeArchive, linesOf, pack, partOf, unpack } from './archiveTestSupport.js';
import { BackupRefusedError, HistoryBackup, type BackupMachine, type BackupOptions } from './HistoryBackup.js';
import { addHistory, FakeVictoria } from './testSupport.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 21, 12);
const source: BackupMachine = { id: 'brother_1', name: 'Speedio #1', type: 'brother' };
const target: BackupMachine = { id: 'brother_2', name: 'Speedio #1', type: 'brother' };
const highLoad: NewAlertRule = {
  kind: 'simple', enabled: true, subject: 'spindle-load', check: 'above', limit: 90, forMinutes: 1, severity: 'warning',
};
const ALL: BackupOptions = { from: null, to: NOW, averagesOnly: false };

describe('HistoryBackup', () => {
  let folder: string;
  let victoria: FakeVictoria;
  let periods: StatePeriodStore;
  let rules: AlertRuleService;
  let freeBytes: number;
  let backups: HistoryBackup;

  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'history-backup-'));
    victoria = new FakeVictoria();
    periods = StatePeriodStore.inMemory();
    rules = AlertRuleService.inMemory();
    freeBytes = 100 * 1024 ** 3;
    backups = new HistoryBackup({
      folder: path.join(folder, 'history-backup'), history: victoria, statePeriods: periods, alertRules: rules, version: '1.4.0',
      now: () => NOW, freeBytes: async () => freeBytes,
    });
    addHistory(victoria, source, NOW - 3 * HOUR, NOW - HOUR);
    periods.open(source.id, 'program', 'O1000', NOW - 3 * HOUR);
    periods.close(source.id, 'program', NOW - 2 * HOUR);
    periods.open(source.id, 'program', 'O2000', NOW - 2 * HOUR);
    periods.markSeen(source.id, NOW - HOUR);
    rules.replaceWithoutPublish(source.id, [highLoad]);
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  async function backUp(options = ALL, machine = source): Promise<Buffer> {
    const prepared = await backups.prepareBackup(machine, options, 'admin');
    return Buffer.from(await new Response(backups.download(prepared.id, machine.id, 'admin')).arrayBuffer());
  }

  function upload(archive: Buffer): ReadableStream<Uint8Array> {
    return new Response(archive).body!;
  }

  async function receive(archive: Buffer, machine = target) {
    return backups.receiveRestore(upload(archive), archive.length, machine, 'admin');
  }

  async function refusalOf(archive: Buffer, machine = target): Promise<BackupRefusedError> {
    const error = await receive(archive, machine).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BackupRefusedError);
    return error as BackupRefusedError;
  }

  const filesLeft = () => (existsSync(path.join(folder, 'history-backup')) ? readdirSync(path.join(folder, 'history-backup')) : []);

  describe('back up', () => {
    it('makes a .tar.gz with the manifest first, and the sha256 and count of each part', async () => {
      const entries = await unpack(await backUp());

      expect([...entries.keys()]).toEqual([
        'manifest.json', 'history/raw.jsonl.gz', 'history/averages.jsonl.gz', 'state-periods.jsonl.gz', 'alert-rules.json',
      ]);
      const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as Manifest;
      expect(manifest).toMatchObject({
        format: 'chatter-machine-history', formatVersion: FORMAT_VERSION, chatterVersion: '1.4.0', createdAt: new Date(NOW).toISOString(),
        machine: source, range: { from: null, to: NOW }, averagesOnly: false, data: { first: NOW - 3 * HOUR, last: NOW - HOUR },
      });
      for (const [name, facts] of Object.entries(manifest.parts)) {
        const data = entries.get(name)!;
        expect(facts).toMatchObject({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
      // 2 hours of 2-second polls, 4 values each
      expect(manifest.parts['history/raw.jsonl.gz']!.count).toBe(3600 * 4);
      expect(manifest.parts['history/averages.jsonl.gz']!.count).toBe(120 * 2 + 1);
      expect(manifest.parts['state-periods.jsonl.gz']!.count).toBe(2);
      expect(manifest.parts['alert-rules.json']!.count).toBe(1);
      expect(linesOf(entries.get('state-periods.jsonl.gz')!).map(line => JSON.parse(line))).toEqual([
        { kind: 'program', value: 'O1000', start: NOW - 3 * HOUR, end: NOW - 2 * HOUR },
        { kind: 'program', value: 'O2000', start: NOW - 2 * HOUR, end: NOW - HOUR },
      ]);
      expect(JSON.parse(entries.get('alert-rules.json')!.toString())).toEqual({ rules: [highLoad] });
    });

    it('with 1-minute averages only, has no raw values', async () => {
      const entries = await unpack(await backUp({ ...ALL, averagesOnly: true }));
      expect(entries.has('history/raw.jsonl.gz')).toBe(false);
      expect(linesOf(entries.get('history/averages.jsonl.gz')!).every(line => /"__name__":"chatter_[a-z_]+:avg1[mh]"/.test(line))).toBe(true);
    });

    it('takes only the time range', async () => {
      const entries = await unpack(await backUp({ from: NOW - 2 * HOUR, to: NOW, averagesOnly: false }));
      const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as Manifest;
      expect(manifest.parts['history/raw.jsonl.gz']!.count).toBe(1800 * 4);
      expect(manifest.parts['state-periods.jsonl.gz']!.count).toBe(2);
    });

    it('allows one backup at a time, and deletes its files after the download', async () => {
      const prepared = await backups.prepareBackup(source, ALL, 'admin');
      await expect(backups.prepareBackup(source, ALL, 'admin')).rejects.toMatchObject({ status: 409 });
      await expect(receive(Buffer.from('x'))).rejects.toMatchObject({ status: 409 });
      expect(filesLeft()).toHaveLength(1);

      await new Response(backups.download(prepared.id, source.id, 'admin')).arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(filesLeft()).toEqual([]);
      expect(() => backups.download(prepared.id, source.id, 'admin')).toThrow(BackupRefusedError);
      await backups.prepareBackup(source, ALL, 'admin');
    });

    it('deletes its files when the browser stops the download', async () => {
      const prepared = await backups.prepareBackup(source, ALL, 'admin');
      const reader = backups.download(prepared.id, source.id, 'admin').getReader();
      await reader.read();
      await reader.cancel();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(filesLeft()).toEqual([]);
      await backups.prepareBackup(source, ALL, 'admin');
    });

    it('refuses a backup larger than the limit, and deletes what it wrote', async () => {
      const limit = ARCHIVE_LIMITS.archiveBytes;
      ARCHIVE_LIMITS.archiveBytes = 10_000;
      try {
        await expect(backups.prepareBackup(source, ALL, 'admin')).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/averages only/) });
      } finally {
        ARCHIVE_LIMITS.archiveBytes = limit;
      }
      expect(filesLeft()).toEqual([]);
      await backups.prepareBackup(source, ALL, 'admin');
    });

    it('refuses when the disk is almost full', async () => {
      freeBytes = ARCHIVE_LIMITS.freeSpaceReserveBytes - 1;
      await expect(backups.prepareBackup(source, ALL, 'admin')).rejects.toMatchObject({ status: 507 });
      expect(filesLeft()).toEqual([]);
    });

    it('logs who made and downloaded it', async () => {
      const log = captureLog();
      await backUp();
      log.restore();
      expect(log.text('info')).toMatch(/History backup made.*machine=brother_1.*user=admin/);
      expect(log.text('info')).toMatch(/History backup downloaded.*user=admin/);
    });
  });

  describe('restore', () => {
    it('restores the history, the periods and the rules into a machine with a new id', async () => {
      const archive = await backUp();
      victoria.removeMachine(source.id);
      const preview = await receive(archive);

      expect(preview).toMatchObject({
        source, chatterVersion: '1.4.0', sameMachine: false, averagesOnly: false,
        counts: { rawSamples: 14400, averageSamples: 241, periods: 2, alertRules: 1 }, tooOld: { samples: 0, periods: 0 },
      });
      const result = await backups.restore(preview.id, target, { alertRules: true }, 'admin');

      expect(result).toEqual({ samples: 14400 + 241, periodsAdded: 2, periodsKnown: 0, alertRules: 1 });
      const fresh = new FakeVictoria();
      addHistory(fresh, target, NOW - 3 * HOUR, NOW - HOUR);
      expect(victoria.samplesOf(target.id)).toEqual(fresh.samplesOf(target.id));
      expect(victoria.importDoneCount).toBe(1);
      expect(periods.read({ machineId: target.id, from: 0, to: NOW, limit: 10 }).map(period => period.value)).toEqual(['O2000', 'O1000']);
      expect(rules.rulesOf(target.id)).toEqual([{ ...highLoad, id: expect.any(String) }]);
      expect(filesLeft()).toEqual([]);
    });

    it('a second restore doubles nothing, and replaces the rules', async () => {
      const archive = await backUp();
      for (const expected of [{ periodsAdded: 2, periodsKnown: 0 }, { periodsAdded: 0, periodsKnown: 2 }]) {
        const preview = await receive(archive);
        expect(await backups.restore(preview.id, target, { alertRules: true }, 'admin')).toMatchObject(expected);
      }
      expect(victoria.samplesOf(target.id)).toHaveLength(14400 + 241);
      expect(periods.read({ machineId: target.id, from: 0, to: NOW, limit: 10 })).toHaveLength(2);
      expect(rules.rulesOf(target.id)).toHaveLength(1);
    });

    it('into the same machine adds nothing that is there already', async () => {
      const archive = await backUp();
      const preview = await receive(archive, source);
      expect(preview.sameMachine).toBe(true);
      expect(await backups.restore(preview.id, source, { alertRules: false }, 'admin')).toMatchObject({ periodsAdded: 0, periodsKnown: 2, alertRules: null });
      expect(victoria.samplesOf(source.id)).toHaveLength(14400 + 241);
    });

    it('keeps the rules of the machine when the user does not choose them', async () => {
      const archive = await backUp();
      const preview = await receive(archive);
      await backups.restore(preview.id, target, { alertRules: false }, 'admin');
      expect(rules.rulesOf(target.id)).toEqual([]);
    });

    it('leaves out the history that is older than the history keeps, and tells how much', async () => {
      const archive = await backUp();
      const later = new HistoryBackup({
        folder: path.join(folder, 'later'), history: victoria, statePeriods: periods, alertRules: rules, version: '1.4.0',
        now: () => NOW + 365 * 24 * HOUR - 1.5 * HOUR, freeBytes: async () => freeBytes,
      });
      const preview = await later.receiveRestore(upload(archive), archive.length, target, 'admin');
      expect(preview.tooOld.samples).toBeGreaterThan(0);
      expect(preview.tooOld.periods).toBe(1);
      expect(preview.counts.periods).toBe(1);
      const result = await later.restore(preview.id, target, { alertRules: false }, 'admin');
      expect(result.samples).toBe(preview.counts.rawSamples + preview.counts.averageSamples);
      expect(result.periodsAdded).toBe(1);
    });

    it('refuses a file of another machine type', async () => {
      const error = await refusalOf(await backUp(), { ...target, type: 'haas' });
      expect(error.message).toMatch(/type brother.*type haas/);
    });

    it('refuses a newer format', async () => {
      const archive = await changeArchive(await backUp(), (_entries, manifest) => {
        manifest.formatVersion = FORMAT_VERSION + 1;
      });
      expect((await refusalOf(archive)).message).toMatch(/newer Chatter/);
    });

    it('refuses a part with a wrong sha256', async () => {
      const archive = await changeArchive(await backUp(), entries => {
        entries.set('state-periods.jsonl.gz', partOf(['{"kind":"program","value":"O9","start":1,"end":2}']));
      }, { fixHashes: false });
      expect((await refusalOf(archive)).message).toMatch(/damaged/);
    });

    it('refuses an entry name that it does not know, also with a path', async () => {
      for (const name of ['../../chatter.db', 'extra.txt']) {
        const archive = await changeArchive(await backUp(), entries => {
          entries.set(name, Buffer.from('x'));
        });
        expect((await refusalOf(archive)).message).toMatch(/does not know/);
        expect(existsSync(path.join(folder, 'chatter.db'))).toBe(false);
      }
    });

    it('refuses a part that the manifest does not name, and a part that is missing', async () => {
      const extra = await changeArchive(await backUp({ ...ALL, averagesOnly: true }), entries => {
        entries.set('history/raw.jsonl.gz', partOf([]));
      });
      expect((await refusalOf(extra)).message).toMatch(/does not name/);
      const missing = await changeArchive(await backUp(), entries => {
        entries.delete('alert-rules.json');
      });
      expect((await refusalOf(missing)).message).toMatch(/has no alert-rules.json/);
    });

    it('refuses a series that is not a Chatter machine value, and writes nothing', async () => {
      const archive = await changeArchive(await backUp(), (entries, manifest) => {
        const lines = linesOf(entries.get('history/raw.jsonl.gz')!);
        lines.push(JSON.stringify({ metric: { __name__: 'ALERTS', machine: source.id, type: 'brother' }, values: [1], timestamps: [NOW - HOUR] }));
        entries.set('history/raw.jsonl.gz', partOf(lines));
        manifest.parts['history/raw.jsonl.gz']!.count += 1;
      });
      victoria.removeMachine(source.id);
      expect((await refusalOf(archive)).message).toMatch(/not a Chatter machine value/);
      expect(victoria.importRequests).toBe(0);
    });

    it('refuses a count that is not the one in the manifest', async () => {
      const archive = await changeArchive(await backUp(), (_entries, manifest) => {
        manifest.parts['state-periods.jsonl.gz']!.count = 1;
      });
      expect((await refusalOf(archive)).message).toMatch(/count of its manifest/);
    });

    it('refuses a line that is too long, and a part that unpacks to too many bytes', async () => {
      const long = await changeArchive(await backUp(), entries => {
        entries.set('state-periods.jsonl.gz', gzipSync(Buffer.alloc(ARCHIVE_LIMITS.lineBytes + 10, 'x')));
      });
      expect((await refusalOf(long)).message).toMatch(/longer than/);

      const limit = ARCHIVE_LIMITS.unpackedPartBytes;
      ARCHIVE_LIMITS.unpackedPartBytes = 1000;
      try {
        expect((await refusalOf(await backUp())).message).toMatch(/unpacks to too many bytes/);
      } finally {
        ARCHIVE_LIMITS.unpackedPartBytes = limit;
      }
    });

    it('refuses a file that is not a .tar.gz, or has no manifest', async () => {
      expect((await refusalOf(Buffer.from('not a gzip file'))).message).toMatch(/not a .tar.gz/);
      expect((await refusalOf(await pack(new Map([['alert-rules.json', '{"rules":[]}']])))).message).toMatch(/no manifest/);
    });

    it('refuses a file larger than the limit before it reads it, and when the upload is longer than it said', async () => {
      await expect(backups.receiveRestore(upload(Buffer.from('x')), ARCHIVE_LIMITS.archiveBytes + 1, target, 'admin'))
        .rejects.toMatchObject({ status: 413 });
      const limit = ARCHIVE_LIMITS.archiveBytes;
      ARCHIVE_LIMITS.archiveBytes = 1000;
      try {
        await expect(backups.receiveRestore(upload(Buffer.alloc(5000)), 10, target, 'admin')).rejects.toMatchObject({ status: 413 });
      } finally {
        ARCHIVE_LIMITS.archiveBytes = limit;
      }
      expect(filesLeft()).toEqual([]);
    });

    it('refuses when the disk does not have room for the file and its parts', async () => {
      const archive = await backUp();
      freeBytes = ARCHIVE_LIMITS.freeSpaceReserveBytes + archive.length;
      expect((await refusalOf(archive)).status).toBe(507);
    });

    it('deletes the files of a refused file, of a cancelled restore, and of a restore that ends', async () => {
      await refusalOf(Buffer.from('not a gzip file'));
      expect(filesLeft()).toEqual([]);
      const preview = await receive(await backUp());
      expect(filesLeft()).toHaveLength(1);
      await backups.cancelRestore(preview.id);
      expect(filesLeft()).toEqual([]);
      await expect(backups.restore(preview.id, target, { alertRules: false }, 'admin')).rejects.toMatchObject({ status: 404 });
    });

    it('keeps one file at a time: a new upload replaces the last one', async () => {
      const archive = await backUp();
      const first = await receive(archive);
      const second = await receive(archive);
      expect(filesLeft()).toHaveLength(1);
      await expect(backups.restore(first.id, target, { alertRules: false }, 'admin')).rejects.toMatchObject({ status: 404 });
      await backups.restore(second.id, target, { alertRules: false }, 'admin');
    });

    it('restores nothing when the rules cannot be saved, and keeps the file for another try', async () => {
      const archive = await backUp();
      const preview = await receive(archive);
      const check = rules.checkRules.bind(rules);
      rules.checkRules = async () => ({ error: 'cannot parse', ruleIndex: 0 });
      await expect(backups.restore(preview.id, target, { alertRules: true }, 'admin')).rejects.toMatchObject({ status: 400 });
      expect(victoria.samplesOf(target.id)).toEqual([]);
      expect(periods.read({ machineId: target.id, from: 0, to: NOW, limit: 10 })).toEqual([]);

      rules.checkRules = check;
      await backups.restore(preview.id, target, { alertRules: true }, 'admin');
      expect(periods.read({ machineId: target.id, from: 0, to: NOW, limit: 10 })).toHaveLength(2);
    });

    it('logs the restore with the user name', async () => {
      const archive = await backUp();
      const log = captureLog();
      const preview = await backups.receiveRestore(upload(archive), archive.length, target, 'boss');
      await backups.restore(preview.id, target, { alertRules: false }, 'boss');
      log.restore();
      expect(log.text('info')).toMatch(/History restored.*machine=brother_2.*user=boss/);
    });
  });

  it('deletes the files that a crash left, at the start', async () => {
    const leftover = path.join(folder, 'history-backup', 'restore-x');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(path.join(leftover, 'upload.tar.gz'), 'x');
    await backups.removeLeftovers();
    expect(filesLeft()).toEqual([]);
  });
});
