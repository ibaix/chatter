import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, rm, statfs } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipelineOf } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import type { NewAlertRule } from '@local-chatter/shared';
import { readTar, tarBytes, TarFormatError, type TarEntry } from '../archive/tar.js';
import { webStreamOf } from '../archive/webStream.js';
import { createLogger } from '../logging/logger.js';
import { KEEP_PERIODS_MS } from '../recording/StatePeriodRecorder.js';
import type { StatePeriodStore } from '../recording/StatePeriodStore.js';
import { alertRulesSchema } from '../routes/schemas.js';
import { FileTooLargeError, StreamIdleError, streamToFile } from '../updates/streamToFile.js';
import {
  ARCHIVE_FORMAT, ARCHIVE_LIMITS, ArchiveError, FORMAT_VERSION, HISTORY_PARTS, MANIFEST_NAME, PART_NAMES, parseManifest, parsePeriodLine,
  PERIODS_PART, RULES_PART, type ArchivedPeriod, type Manifest, type PartFacts, type PartName,
} from './archive.js';
import { relabelLine, sampleFacts, textLines, type RelabelTarget } from './relabel.js';
import { AVERAGE_SERIES, RAW_SERIES, type ExportRange, type HistoryStore } from './victoriaHistory.js';

const log = createLogger('history-backup');

/** A prepared backup or an uploaded restore file waits this long for the next step, then Chatter deletes it */
const WAIT_FOR_NEXT_STEP_MS = 30 * 60_000;
/** A download or an upload stops when no bytes move for this long */
const IDLE_LIMIT_MS = 5 * 60_000;
/** The periods that a backup reads from SQLite at one time */
const PERIOD_PAGE = 5000;
/** The most bytes of lines in one request to /api/v1/import */
const IMPORT_BATCH_BYTES = 4 * 1024 * 1024;
/** Periods put in the temporary table at one time */
const PERIOD_BATCH = 1000;
/** A sample may be this far in the future, for a clock that is a little wrong */
const CLOCK_SKEW_MS = 60 * 60_000;
/** The rest of the file name when the machine name has no letter or digit */
const FALLBACK_NAME = 'machine';
const NO_FREE_SPACE_MESSAGE = 'The disk of Chatter does not have enough free space for this.';
const DISK_FULL_MESSAGE = 'The disk of Chatter is full. Make free space, then try again.';

/** The machine of a backup or a restore */
export interface BackupMachine {
  id: string;
  name: string;
  type: string;
}

export interface BackupOptions {
  /** Null for all the history */
  from: number | null;
  to: number;
  /** Only the minute and hour averages, not the raw values: a much smaller file */
  averagesOnly: boolean;
}

/** Where the restore reads and writes the alert rules. AlertRuleService does this. */
export interface RestorableRules {
  rulesOf(machineId: string): NewAlertRule[];
  checkRules(machineId: string, rules: NewAlertRule[]): Promise<{ error: string; ruleIndex: number } | null>;
  replaceWithoutPublish(machineId: string, rules: NewAlertRule[]): void;
  publish(): Promise<boolean>;
}

export interface HistoryBackupParts {
  /** A folder in the data volume, only for this. Chatter deletes all of it at each start. A function is read at the first use. */
  folder: string | (() => string);
  history: HistoryStore;
  statePeriods: StatePeriodStore;
  alertRules: RestorableRules;
  version: string;
  now?: () => number;
  /** The free bytes on the disk of the folder */
  freeBytes?: (folder: string) => Promise<number>;
}

/** A request that Chatter does not do. The message tells the user why. */
export class BackupRefusedError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 507) {
    super(message);
  }
}

export interface PreparedBackup {
  id: string;
  fileName: string;
  manifest: Manifest;
}

/** What the user sees before a restore */
export interface RestorePreview {
  id: string;
  source: BackupMachine;
  chatterVersion: string;
  createdAt: string;
  range: Manifest['range'];
  data: Manifest['data'];
  averagesOnly: boolean;
  counts: { rawSamples: number; averageSamples: number; periods: number; alertRules: number };
  /** Left out, because they are older than the history keeps */
  tooOld: { samples: number; periods: number };
  /** The file comes from this machine (the same id) */
  sameMachine: boolean;
}

export interface RestoreResult {
  samples: number;
  periodsAdded: number;
  /** Periods that the machine had already, for example after a second restore */
  periodsKnown: number;
  /** Null when the user did not restore the alert rules */
  alertRules: number | null;
}

interface Prepared extends PreparedBackup {
  machineId: string;
  folder: string;
  timer: NodeJS.Timeout;
}

interface PendingRestore {
  preview: RestorePreview;
  manifest: Manifest;
  machineId: string;
  folder: string;
  timer: NodeJS.Timeout;
}

/** The parts of a received file, by their name in the archive. The local file name never comes from the archive. */
type ReceivedParts = Map<string, { file: string; bytes: number; sha256: string }>;

/**
 * Back up the history of one machine to a .tar.gz file, and restore such a file into a machine.
 * Only one backup or restore runs at a time. Each one uses its own folder in `folder`, and deletes it at its end.
 *
 * A backup: VictoriaMetrics → gzip → files in the folder, then a tar of them to the browser (a tar needs each size first).
 * A restore: the upload → a file in the folder → its parts → a full check → then the user confirms → the writes.
 */
export class HistoryBackup {
  private readonly folderOf: () => string;
  private readonly history: HistoryStore;
  private readonly statePeriods: StatePeriodStore;
  private readonly alertRules: RestorableRules;
  private readonly version: string;
  private readonly now: () => number;
  private readonly freeBytes: (folder: string) => Promise<number>;

  private get folder(): string {
    return this.folderOf();
  }

  /** What runs now. A prepared backup holds it until its download ends. */
  private running: 'backup' | 'restore' | null = null;
  private prepared: Prepared | null = null;
  private pending: PendingRestore | null = null;

  constructor({ folder, history, statePeriods, alertRules, version, now = Date.now, freeBytes = freeBytesOf }: HistoryBackupParts) {
    this.folderOf = typeof folder === 'string' ? () => folder : folder;
    this.history = history;
    this.statePeriods = statePeriods;
    this.alertRules = alertRules;
    this.version = version;
    this.now = now;
    this.freeBytes = freeBytes;
  }

  /** At the start: delete the files of a backup or a restore that a stop or a crash left */
  async removeLeftovers(): Promise<void> {
    await rm(this.folder, { recursive: true, force: true });
  }

  /**
   * Read the history of the machine into files. The download of the file comes next.
   * `signal` is the request: when the browser or a proxy stops it, the backup stops and frees the place.
   */
  async prepareBackup(machine: BackupMachine, options: BackupOptions, user: string, signal?: AbortSignal): Promise<PreparedBackup> {
    // A backup of the same machine that nobody downloads yet (for example after a proxy time limit) gives its place
    if (this.prepared?.machineId === machine.id) await this.dropPrepared(this.prepared.id);
    this.start('backup');
    const id = randomUUID();
    const folder = path.join(this.folder, `backup-${id}`);
    const abort = new AbortController();
    const stop = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw signal.reason;
      await mkdir(folder, { recursive: true });
      const budget = await this.backupBudget();
      const manifest = await this.writeBackupParts(folder, machine, options, budget, abort.signal);
      abort.signal.throwIfAborted();
      const fileName = `chatter-history-${fileNamePart(machine.name)}-${new Date(this.now()).toISOString().slice(0, 10)}.tar.gz`;
      const timer = setTimeout(() => void this.dropPrepared(id), WAIT_FOR_NEXT_STEP_MS);
      timer.unref();
      this.prepared = { id, fileName, manifest, machineId: machine.id, folder, timer };
      log.info('History backup made', { machine: machine.id, user, bytes: budget.used, averagesOnly: options.averagesOnly });
      return { id, fileName, manifest };
    } catch (error) {
      abort.abort();
      await rm(folder, { recursive: true, force: true });
      this.running = null;
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  /** The prepared backup as a .tar.gz stream. Its files are deleted at the end of the download, or when it stops. */
  download(id: string, machineId: string, user: string): { fileName: string; stream: ReadableStream<Uint8Array> } {
    const prepared = this.prepared;
    if (!prepared || prepared.id !== id || prepared.machineId !== machineId) {
      throw new BackupRefusedError('This backup is not ready, or it was downloaded already. Make a new backup.', 404);
    }
    clearTimeout(prepared.timer);
    this.prepared = null;
    const entries: TarEntry[] = [
      { name: MANIFEST_NAME, text: `${JSON.stringify(prepared.manifest, null, 2)}\n` },
      ...Object.keys(prepared.manifest.parts).map(name => ({ name, filePath: path.join(prepared.folder, localName(name)) })),
    ];
    // The parts are gzip already, but gzip of the exported lines stays very repetitive (long runs of 0, and times
    // 2 seconds apart). A second gzip makes the file about 8 times smaller.
    // Bytes go through only while the browser takes them. When it stops for IDLE_LIMIT_MS, the download stops.
    let idleTimer: NodeJS.Timeout | undefined;
    const restartIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => source.destroy(new Error('The download stopped')), IDLE_LIMIT_MS);
      idleTimer.unref();
    };
    const watch = new Transform({
      transform(piece: Buffer, _encoding, done: TransformCallback) {
        restartIdle();
        done(null, piece);
      },
    });
    // pipeline() and not pipe(): when the download stops, each stage stops and closes its file
    pipelineOf(Readable.from(tarBytes(entries, new Date(this.now()))), createGzip(), watch, () => {});
    const source = watch;
    restartIdle();
    log.info('History backup downloaded', { machine: machineId, user });
    const stream = webStreamOf(source, () => {
      clearTimeout(idleTimer);
      void rm(prepared.folder, { recursive: true, force: true });
      this.running = null;
    });
    return { fileName: prepared.fileName, stream };
  }

  /**
   * Receive a restore file for the machine, and check all of it. Nothing is written to the history yet.
   * Gives the preview. restore() with its id does the writes.
   */
  async receiveRestore(body: ReadableStream<Uint8Array>, size: number, target: BackupMachine, user: string): Promise<RestorePreview> {
    if (size > ARCHIVE_LIMITS.archiveBytes) throw new BackupRefusedError(tooLargeMessage(), 413);
    this.start('restore');
    const id = randomUUID();
    const folder = path.join(this.folder, `restore-${id}`);
    try {
      await this.dropPending();
      await mkdir(folder, { recursive: true });
      await this.requireFreeBytes(size);
      const upload = path.join(folder, 'upload.tar.gz');
      await receiveUpload(body, upload);
      // The parts can be much larger than the upload, so the free space is checked again before each one
      const parts = await extractParts(upload, folder, bytes => this.requireFreeBytes(bytes));
      await rm(upload, { force: true });
      const manifest = await checkParts(parts);
      if (manifest.machine.type !== target.type) {
        throw new ArchiveError(`The file is from a machine of the type ${manifest.machine.type}. This machine is of the type ${target.type}.`);
      }
      const checked = await this.checkContent(folder, manifest, target);
      const preview: RestorePreview = {
        id,
        source: manifest.machine,
        chatterVersion: manifest.chatterVersion,
        createdAt: manifest.createdAt,
        range: manifest.range,
        data: manifest.data,
        averagesOnly: manifest.averagesOnly,
        counts: checked.counts,
        tooOld: checked.tooOld,
        sameMachine: manifest.machine.id === target.id,
      };
      const timer = setTimeout(() => void this.dropPending(id), WAIT_FOR_NEXT_STEP_MS);
      timer.unref();
      this.pending = { preview, manifest, machineId: target.id, folder, timer };
      log.info('History restore file received', { machine: target.id, user, source: manifest.machine.id, bytes: size });
      return preview;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw refusalOf(error);
    } finally {
      this.running = null;
    }
  }

  /** Write the received file into the history of the machine. A failed restore can run again: it does not double anything. */
  async restore(id: string, target: BackupMachine, options: { alertRules: boolean }, user: string): Promise<RestoreResult> {
    const pending = this.pending;
    if (!pending || pending.preview.id !== id || pending.machineId !== target.id) {
      throw new BackupRefusedError('This restore file is not ready. Upload the file again.', 404);
    }
    this.start('restore');
    // The file must not expire while the restore runs
    clearTimeout(pending.timer);
    try {
      const rules = options.alertRules ? await this.checkedRules(pending, target.id) : null;
      const samples = await this.importAllHistory(pending, target);
      const periods = await this.restorePeriods(pending, target.id, rules);
      if (rules) await this.alertRules.publish();
      log.info('History restored', {
        machine: target.id, user, source: pending.manifest.machine.id, samples, periods: periods.added, alertRules: rules?.length ?? 'kept',
      });
      clearTimeout(pending.timer);
      this.pending = null;
      await rm(pending.folder, { recursive: true, force: true });
      return { samples, periodsAdded: periods.added, periodsKnown: periods.known, alertRules: rules?.length ?? null };
    } catch (error) {
      log.error('History restore failed. The file stays, so the user can try again.', { machine: target.id, user, error });
      pending.timer = setTimeout(() => void this.dropPending(id), WAIT_FOR_NEXT_STEP_MS);
      pending.timer.unref();
      throw refusalOf(error);
    } finally {
      this.running = null;
    }
  }

  /** Delete a received restore file that the user does not want. Not while its restore runs: the restore reads the file. */
  async cancelRestore(id: string, machineId: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.preview.id !== id || pending.machineId !== machineId) {
      throw new BackupRefusedError('This restore file is not there. It was deleted already.', 404);
    }
    if (this.running === 'restore') throw new BackupRefusedError('The restore of this file runs now. It cannot be cancelled.', 409);
    await this.dropPending(id);
  }

  private start(kind: 'backup' | 'restore'): void {
    if (this.running) {
      throw new BackupRefusedError(`A history ${this.running} runs now. Only one backup or restore can run at a time. Try again later.`, 409);
    }
    this.running = kind;
  }

  private async requireFreeBytes(needed: number): Promise<void> {
    const free = await this.freeBytes(this.folder);
    if (free < needed + ARCHIVE_LIMITS.freeSpaceReserveBytes) {
      throw new BackupRefusedError(NO_FREE_SPACE_MESSAGE, 507);
    }
  }

  /** The bytes that the parts of a backup can use: at most the file limit, and only the free space of the disk */
  private async backupBudget(): Promise<ByteBudget> {
    const room = (await this.freeBytes(this.folder)) - ARCHIVE_LIMITS.freeSpaceReserveBytes;
    if (room < ARCHIVE_LIMITS.archiveBytes) {
      if (room <= 0) throw new BackupRefusedError(NO_FREE_SPACE_MESSAGE, 507);
      return new ByteBudget(room, () => new BackupRefusedError(`${NO_FREE_SPACE_MESSAGE} Choose a shorter time range, or 1-minute averages only.`, 507));
    }
    return new ByteBudget(ARCHIVE_LIMITS.archiveBytes, () => new BackupRefusedError(
      `The backup is larger than ${gigabytes(ARCHIVE_LIMITS.archiveBytes)}. Choose a shorter time range, or 1-minute averages only.`, 413,
    ));
  }

  private relabelTarget(target: BackupMachine, manifest: Manifest): RelabelTarget {
    const now = this.now();
    return {
      machineId: target.id, sourceMachineId: manifest.machine.id, machineType: target.type,
      notBefore: now - KEEP_PERIODS_MS, notAfter: now + CLOCK_SKEW_MS,
    };
  }

  private async writeBackupParts(
    folder: string, machine: BackupMachine, options: BackupOptions, budget: ByteBudget, signal: AbortSignal,
  ): Promise<Manifest> {
    const range: ExportRange = { from: options.from, to: options.to };
    const span = new TimeSpan();
    const parts: Manifest['parts'] = {};
    const series: [PartName, string][] = options.averagesOnly
      ? [['history/averages.jsonl.gz', AVERAGE_SERIES]]
      : [['history/raw.jsonl.gz', RAW_SERIES], ['history/averages.jsonl.gz', AVERAGE_SERIES]];
    for (const [name, pattern] of series) {
      const exported = await this.history.exportSeries(machine.id, pattern, range, signal);
      parts[name] = await writeGzipPart(path.join(folder, localName(name)), countedSeries(exported, span), budget, signal);
    }
    parts[PERIODS_PART] = await writeGzipPart(path.join(folder, localName(PERIODS_PART)), this.periodLines(machine.id, range, span), budget, signal);
    const rules = this.alertRules.rulesOf(machine.id).map(withoutId);
    const rulesText = `${JSON.stringify({ rules }, null, 2)}\n`;
    parts[RULES_PART] = await writeGzipPart(path.join(folder, localName(RULES_PART)), oneText(rulesText, rules.length), budget, signal, false);
    return {
      format: ARCHIVE_FORMAT,
      formatVersion: FORMAT_VERSION,
      chatterVersion: this.version,
      createdAt: new Date(this.now()).toISOString(),
      machine: { id: machine.id, name: machine.name, type: machine.type },
      range: { from: options.from, to: options.to },
      averagesOnly: options.averagesOnly,
      data: { first: span.first, last: span.last },
      parts,
    };
  }

  private async *periodLines(machineId: string, { from, to }: ExportRange, span: TimeSpan): AsyncGenerator<string> {
    let afterId = 0;
    for (;;) {
      const page = this.statePeriods.periodsForBackup({ machineId, from, to, afterId, limit: PERIOD_PAGE });
      for (const { period } of page) {
        span.add(period.start, period.end);
        yield `${JSON.stringify(period)}\n`;
      }
      if (page.length < PERIOD_PAGE) return;
      afterId = page[page.length - 1].id;
    }
  }

  /** Read each part to its end, so a bad line is found before anything is written */
  private async checkContent(folder: string, manifest: Manifest, target: BackupMachine) {
    const relabel = this.relabelTarget(target, manifest);
    const counts = { rawSamples: 0, averageSamples: 0, periods: 0, alertRules: 0 };
    const tooOld = { samples: 0, periods: 0 };
    for (const part of HISTORY_PARTS) {
      if (!manifest.parts[part]) continue;
      let samples = 0;
      let old = 0;
      for await (const line of unpackedLines(path.join(folder, localName(part)))) {
        const result = relabelLine(line, relabel);
        samples += result.samples;
        old += result.tooOld;
        checkCount(manifest, part, samples + old, false);
      }
      checkCount(manifest, part, samples + old, true);
      counts[part === 'history/raw.jsonl.gz' ? 'rawSamples' : 'averageSamples'] = samples;
      tooOld.samples += old;
    }
    if (manifest.parts[PERIODS_PART]) {
      let all = 0;
      for await (const line of unpackedLines(path.join(folder, localName(PERIODS_PART)))) {
        const period = parsePeriodLine(line);
        all += 1;
        checkCount(manifest, PERIODS_PART, all, false);
        if (period.end < relabel.notBefore) tooOld.periods += 1;
        if (period.start > relabel.notAfter) throw new ArchiveError('The file has a state period with a time in the future.');
      }
      checkCount(manifest, PERIODS_PART, all, true);
      counts.periods = all - tooOld.periods;
    }
    if (manifest.parts[RULES_PART]) {
      counts.alertRules = (await readRules(path.join(folder, localName(RULES_PART)))).length;
      checkCount(manifest, RULES_PART, counts.alertRules, true);
    }
    return { counts, tooOld };
  }

  /** The alert rules of the file, when the machine can save them all. Null when the file has none. */
  private async checkedRules(pending: PendingRestore, machineId: string): Promise<NewAlertRule[] | null> {
    if (!pending.manifest.parts[RULES_PART]) return null;
    const rules = await readRules(path.join(pending.folder, localName(RULES_PART)));
    const problem = await this.alertRules.checkRules(machineId, rules);
    if (problem) throw new ArchiveError(`Alert rule ${problem.ruleIndex + 1} of the file cannot be saved: ${problem.error}`);
    return rules;
  }

  private async importAllHistory(pending: PendingRestore, target: BackupMachine): Promise<number> {
    const relabel = this.relabelTarget(target, pending.manifest);
    let samples = 0;
    for (const part of HISTORY_PARTS) {
      if (pending.manifest.parts[part]) samples += await this.importHistory(path.join(pending.folder, localName(part)), relabel);
    }
    if (samples > 0) await this.history.importDone();
    return samples;
  }

  /** Send the relabelled lines to VictoriaMetrics, in batches. Gives the sample count. */
  private async importHistory(file: string, relabel: RelabelTarget): Promise<number> {
    let batch: string[] = [];
    let batchBytes = 0;
    let samples = 0;
    const send = async () => {
      if (batch.length > 0) await this.history.importLines(`${batch.join('\n')}\n`);
      batch = [];
      batchBytes = 0;
    };
    for await (const line of unpackedLines(file)) {
      const result = relabelLine(line, relabel);
      if (result.line === null) continue;
      samples += result.samples;
      batch.push(result.line);
      batchBytes += result.line.length;
      if (batchBytes >= IMPORT_BATCH_BYTES) await send();
    }
    await send();
    return samples;
  }

  private async restorePeriods(pending: PendingRestore, machineId: string, rules: NewAlertRule[] | null) {
    const notBefore = this.now() - KEEP_PERIODS_MS;
    const stage = this.statePeriods.startRestore();
    try {
      if (pending.manifest.parts[PERIODS_PART]) {
        let batch: ArchivedPeriod[] = [];
        for await (const line of unpackedLines(path.join(pending.folder, localName(PERIODS_PART)))) {
          const period = parsePeriodLine(line);
          if (period.end >= notBefore) batch.push(period);
          if (batch.length >= PERIOD_BATCH) {
            stage.add(batch);
            batch = [];
          }
        }
        stage.add(batch);
      }
      // One transaction: the periods and the alert rules are both restored, or neither
      return stage.commit(machineId, () => {
        if (rules) this.alertRules.replaceWithoutPublish(machineId, rules);
      });
    } finally {
      stage.drop();
    }
  }

  private async dropPrepared(id: string): Promise<void> {
    const prepared = this.prepared;
    if (!prepared || prepared.id !== id) return;
    clearTimeout(prepared.timer);
    this.prepared = null;
    this.running = null;
    await rm(prepared.folder, { recursive: true, force: true });
  }

  private async dropPending(id?: string): Promise<void> {
    const pending = this.pending;
    if (!pending || (id !== undefined && pending.preview.id !== id)) return;
    clearTimeout(pending.timer);
    this.pending = null;
    await rm(pending.folder, { recursive: true, force: true });
  }
}

async function freeBytesOf(folder: string): Promise<number> {
  // The folder may not be there yet: its parent is on the same disk
  const stats = await statfs(folder).catch(() => statfs(path.dirname(folder)));
  return stats.bavail * stats.bsize;
}

/** The name of a part on the disk. It never comes from the archive, so a name such as ../x cannot reach another folder. */
function localName(part: string): string {
  return part === MANIFEST_NAME ? 'manifest.json' : `part-${PART_NAMES.indexOf(part as PartName)}`;
}

/** The machine name for the file name: letters, digits and dashes only */
function fileNamePart(name: string): string {
  const safe = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return safe || FALLBACK_NAME;
}

function gigabytes(bytes: number): string {
  return `${bytes / 1024 ** 3} GB`;
}

/** The reply to a restore file that is too large */
export function tooLargeMessage(): string {
  return `The file is larger than ${gigabytes(ARCHIVE_LIMITS.archiveBytes)}.`;
}

/** A rule without its id: the restore gives new ids */
function withoutId(rule: NewAlertRule & { id?: string }): NewAlertRule {
  const { id: _id, ...rest } = rule;
  return rest as NewAlertRule;
}

/** The first and last time of the data in a backup */
class TimeSpan {
  first: number | null = null;
  last: number | null = null;

  add(first: number, last: number): void {
    this.first = this.first === null ? first : Math.min(this.first, first);
    this.last = this.last === null ? last : Math.max(this.last, last);
  }
}

/** The bytes that all the parts of a backup or a restore can use together */
class ByteBudget {
  used = 0;
  constructor(private readonly limit: number, private readonly error: () => Error) {}

  take(bytes: number): void {
    this.used += bytes;
    if (this.used > this.limit) throw this.error();
  }
}

/** A text and the count for the manifest, as the lines of a part */
interface CountedLines extends AsyncIterable<string> {
  count(): number;
}

function oneText(text: string, count: number): CountedLines {
  return { count: () => count, async *[Symbol.asyncIterator]() {
    yield text;
  } };
}

/** The exported lines, with a count of their samples */
function countedSeries(exported: AsyncIterable<Uint8Array>, span: TimeSpan): CountedLines {
  let samples = 0;
  return {
    count: () => samples,
    async *[Symbol.asyncIterator]() {
      for await (const exportedLine of textLines(exported, ARCHIVE_LIMITS.lineBytes)) {
        const { line, samples: count, first, last } = sampleFacts(exportedLine);
        if (line === null || first === null || last === null) continue;
        samples += count;
        span.add(first, last);
        yield `${line}\n`;
      }
    },
  };
}

/** Write the lines to a new file, gzip or not, with the sha256 and the size of the file */
async function writeGzipPart(
  file: string, lines: AsyncIterable<string> & Partial<CountedLines>, budget: ByteBudget, signal: AbortSignal, gzip = true,
): Promise<PartFacts> {
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(piece: Buffer, _encoding, done: TransformCallback) {
      try {
        budget.take(piece.length);
      } catch (error) {
        done(error as Error);
        return;
      }
      bytes += piece.length;
      hash.update(piece);
      done(null, piece);
    },
  });
  let count = 0;
  async function* counted() {
    for await (const line of lines) {
      count += 1;
      yield line;
    }
  }
  const stages = gzip ? [Readable.from(counted()), createGzip(), measure] : [Readable.from(counted()), measure];
  await pipeline([...stages, createWriteStream(file, { flags: 'wx' })], { signal });
  return { bytes, sha256: hash.digest('hex'), count: lines.count?.() ?? count };
}

async function receiveUpload(body: ReadableStream<Uint8Array>, file: string): Promise<void> {
  try {
    await streamToFile(body, file, { maxBytes: ARCHIVE_LIMITS.archiveBytes, idleMs: IDLE_LIMIT_MS });
  } catch (error) {
    if (error instanceof FileTooLargeError) throw new BackupRefusedError(tooLargeMessage(), 413);
    if (error instanceof StreamIdleError) throw new BackupRefusedError(`The upload stopped: ${error.message}.`, 400);
    throw error;
  }
}

/** The size limit of each entry of the archive */
function entryLimit(name: string): number {
  if (name === MANIFEST_NAME) return ARCHIVE_LIMITS.manifestBytes;
  if (name === RULES_PART) return ARCHIVE_LIMITS.alertRulesBytes;
  return ARCHIVE_LIMITS.archiveBytes;
}

/** Unpack the tar.gz into the folder. Only the known entries, each once and within its size limit. */
async function extractParts(upload: string, folder: string, requireFreeBytes: (bytes: number) => Promise<void>): Promise<ReceivedParts> {
  const parts: ReceivedParts = new Map();
  const budget = new ByteBudget(ARCHIVE_LIMITS.archiveBytes, () => new BackupRefusedError(tooLargeMessage(), 413));
  const open = new Set<WriteStream>();
  try {
    await pipeline(createReadStream(upload), createGunzip(), async (source: AsyncIterable<Uint8Array>) => {
      await readTar(source, async ({ name, size }) => {
        if (name !== MANIFEST_NAME && !(PART_NAMES as readonly string[]).includes(name)) {
          throw new ArchiveError(`The file has an entry that Chatter does not know: ${name.slice(0, 100)}`);
        }
        if (parts.has(name)) throw new ArchiveError(`The file has the entry ${name} two times.`);
        if (size > entryLimit(name)) throw new ArchiveError(`The entry ${name} of the file is too large.`);
        budget.take(size);
        await requireFreeBytes(size);
        const file = path.join(folder, localName(name));
        const out = createWriteStream(file, { flags: 'wx' });
        open.add(out);
        // A write error (for example a full disk) can come at any time, also between two writes. It stops the next step.
        let failure: Error | null = null;
        out.on('error', (error: Error) => {
          failure ??= error;
        });
        const hash = createHash('sha256');
        const wait = async (event: 'drain' | 'finish') => {
          if (failure) throw failure;
          await once(out, event);
        };
        return {
          write: async piece => {
            if (failure) throw failure;
            hash.update(piece);
            if (!out.write(piece)) await wait('drain');
          },
          end: async () => {
            if (failure) throw failure;
            out.end();
            await wait('finish');
            open.delete(out);
            parts.set(name, { file, bytes: size, sha256: hash.digest('hex') });
          },
        };
      });
    });
  } catch (error) {
    if (error instanceof TarFormatError) throw new ArchiveError(`The file is not a correct history backup: ${error.message}.`);
    if (isZlibError(error)) throw new ArchiveError('The file is not a .tar.gz file.');
    throw error;
  } finally {
    for (const out of open) out.destroy();
  }
  return parts;
}

/** The manifest, when each part that it names is in the file with the same size and sha256, and no other part is */
async function checkParts(parts: ReceivedParts): Promise<Manifest> {
  const manifestPart = parts.get(MANIFEST_NAME);
  if (!manifestPart) throw new ArchiveError('The file is not a history backup of Chatter: it has no manifest.json.');
  const manifest = parseManifest(await readFile(manifestPart.file, 'utf8'));
  for (const [name, expected] of Object.entries(manifest.parts)) {
    const found = parts.get(name);
    if (!found) throw new ArchiveError(`The file has no ${name}, but its manifest names it.`);
    if (found.bytes !== expected.bytes || found.sha256 !== expected.sha256) {
      throw new ArchiveError(`The ${name} part of the file is damaged: its sha256 is not the one in the manifest.`);
    }
  }
  const extra = [...parts.keys()].find(name => name !== MANIFEST_NAME && !(name in manifest.parts));
  if (extra) throw new ArchiveError(`The file has ${extra}, but its manifest does not name it.`);
  return manifest;
}

/** The count of a part must be the one in the manifest. During the read, `final` is false and the count must not be more. */
function checkCount(manifest: Manifest, part: PartName, found: number, final: boolean): void {
  const expected = manifest.parts[part]?.count ?? 0;
  if (found > expected || (final && found !== expected)) {
    throw new ArchiveError(`The ${part} part of the file does not have the count of its manifest.`);
  }
}

/** The lines of a gzip part on the disk, with the limits of a line and of all the unpacked bytes */
async function* unpackedLines(file: string): AsyncGenerator<string> {
  let unpacked = 0;
  const limit = new Transform({
    transform(piece: Buffer, _encoding, done: TransformCallback) {
      unpacked += piece.length;
      if (unpacked > ARCHIVE_LIMITS.unpackedPartBytes) done(new ArchiveError('A part of the file unpacks to too many bytes.'));
      else done(null, piece);
    },
  });
  // pipeline() and not pipe(): an error of the file or of gunzip reaches the read below, and each stage closes
  pipelineOf(createReadStream(file), createGunzip(), limit, () => {});
  try {
    yield* textLines(limit, ARCHIVE_LIMITS.lineBytes);
  } catch (error) {
    if (isZlibError(error)) throw new ArchiveError('A part of the file is not correct gzip.');
    throw error;
  } finally {
    limit.destroy();
  }
}

async function readRules(file: string): Promise<NewAlertRule[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new ArchiveError('The alert rules of the file are not JSON.');
  }
  const parsed = alertRulesSchema.safeParse(value);
  if (!parsed.success) throw new ArchiveError(`The alert rules of the file are not correct: ${parsed.error.issues[0].message}`);
  return parsed.data.rules.map(rule => withoutId(rule as NewAlertRule & { id?: string }));
}

function isZlibError(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code.startsWith('Z_');
}

/** A problem with the file is a refusal with status 400. A full disk is a refusal with status 507. */
function refusalOf(error: unknown): unknown {
  if (error instanceof ArchiveError) return new BackupRefusedError(error.message, 400);
  if ((error as { code?: unknown })?.code === 'ENOSPC') return new BackupRefusedError(DISK_FULL_MESSAGE, 507);
  return error;
}
