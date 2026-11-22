import { StringDecoder } from 'node:string_decoder';
import { ArchiveError } from './archive.js';

/**
 * The raw values and the averages of the history (metricLines.ts and vmalert/rules.yml). A restore writes only these
 * series, so a file cannot add or change other series, for example the alert state of vmalert.
 */
const CHATTER_METRIC = /^chatter_[a-z0-9_]+(:avg1[mh])?$/;
const MACHINE_LABEL = 'machine';
const TYPE_LABEL = 'type';
const NAME_LABEL = '__name__';
/** Chatter writes only these labels. A restore refuses a series with another label. */
const KNOWN_LABELS = new Set([NAME_LABEL, MACHINE_LABEL, TYPE_LABEL]);

/** Where the samples of a restore go, and the times that the history can keep */
export interface RelabelTarget {
  machineId: string;
  /** The machine that the manifest names. Each series of the file must be of this machine. */
  sourceMachineId: string;
  machineType: string;
  /** VictoriaMetrics deletes older samples at once, so they are left out */
  notBefore: number;
  /** A later sample is in the future: the file is not correct */
  notAfter: number;
}

export interface RelabelledLine {
  /** The line for /api/v1/import, or null when each sample is too old */
  line: string | null;
  samples: number;
  /** The samples left out, because they are older than the history keeps */
  tooOld: number;
}

/** One line of /api/v1/export: one block of samples of one series */
interface ExportedSeries {
  metric: Record<string, string>;
  values: number[];
  timestamps: number[];
}

/**
 * A line as VictoriaMetrics exports it. A value is null for a staleness marker: vmalert writes one when a series of
 * a recording rule stops (for example when a machine is removed). A marker is not a sample, so Chatter leaves it out.
 */
interface ExportedLine extends Omit<ExportedSeries, 'values'> {
  values: (number | null)[];
}

/**
 * The line with the machine label of the target machine. No other label changes.
 * Refuses a line that is not a chatter_* series of the machine of the manifest and of the same machine type,
 * a line with another label, and a sample in the future.
 */
export function relabelLine(text: string, target: RelabelTarget): RelabelledLine {
  const series = withoutStaleMarkers(parseSeries(text));
  const { metric } = series;
  const unknown = Object.keys(metric).find(label => !KNOWN_LABELS.has(label));
  if (unknown !== undefined) {
    throw new ArchiveError(`The file has a series with the label ${unknown.slice(0, 100)}. Chatter writes only the labels __name__, machine and type.`);
  }
  if (metric[MACHINE_LABEL] === undefined) throw new ArchiveError('The file has a series with no machine label.');
  if (metric[MACHINE_LABEL] !== target.sourceMachineId) throw new ArchiveError('The file has history of another machine than the machine of its manifest.');
  if (metric[TYPE_LABEL] !== target.machineType) throw new ArchiveError('The file has history of another machine type.');
  const keep = series.timestamps.map(time => time >= target.notBefore);
  if (series.timestamps.some(time => time > target.notAfter)) throw new ArchiveError('The file has history with a time in the future.');
  const samples = keep.filter(Boolean).length;
  const tooOld = keep.length - samples;
  if (samples === 0) return { line: null, samples, tooOld };
  const relabelled: ExportedSeries = {
    metric: { [NAME_LABEL]: metric[NAME_LABEL], [MACHINE_LABEL]: target.machineId, [TYPE_LABEL]: metric[TYPE_LABEL] },
    values: tooOld === 0 ? series.values : series.values.filter((_value, index) => keep[index]),
    timestamps: tooOld === 0 ? series.timestamps : series.timestamps.filter((_time, index) => keep[index]),
  };
  return { line: JSON.stringify(relabelled), samples, tooOld };
}

/** An exported line for a backup */
export interface BackupLine {
  /** The line without staleness markers, or null when it has no sample */
  line: string | null;
  samples: number;
  first: number | null;
  last: number | null;
}

/** The line for the backup, its sample count, and its first and last time, for the manifest. The samples need not be in time order. */
export function sampleFacts(text: string): BackupLine {
  const parsed = parseSeries(text);
  const series = withoutStaleMarkers(parsed);
  const { timestamps } = series;
  const line = series === parsed ? text : JSON.stringify(series);
  if (timestamps.length === 0) return { line: null, samples: 0, first: null, last: null };
  let first = timestamps[0];
  let last = timestamps[0];
  for (const time of timestamps) {
    if (time < first) first = time;
    if (time > last) last = time;
  }
  return { line, samples: timestamps.length, first, last };
}

/** The series without its staleness markers. The same object when it has none. */
function withoutStaleMarkers(series: ExportedLine): ExportedSeries {
  const { values } = series;
  if (!values.includes(null)) return series as ExportedSeries;
  const keep = values.map(value => value !== null);
  return {
    metric: series.metric,
    values: values.filter((value): value is number => value !== null),
    timestamps: series.timestamps.filter((_time, index) => keep[index]),
  };
}

function parseSeries(text: string): ExportedLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArchiveError('A line of the history is not JSON.');
  }
  const { metric, values, timestamps } = (value ?? {}) as Partial<ExportedLine>;
  checkMetric(metric);
  if (!Array.isArray(values) || !Array.isArray(timestamps) || values.length !== timestamps.length) {
    throw new ArchiveError('A line of the history has not the same number of values and times.');
  }
  if (!values.every(item => item === null || (typeof item === 'number' && Number.isFinite(item)))) throw new ArchiveError('A line of the history has a value that is not a number.');
  if (!timestamps.every(item => Number.isSafeInteger(item) && item >= 0)) throw new ArchiveError('A line of the history has a time that is not correct.');
  return { metric, values, timestamps };
}

function checkMetric(metric: unknown): asserts metric is Record<string, string> {
  if (typeof metric !== 'object' || metric === null || Array.isArray(metric)) throw new ArchiveError('A line of the history has no metric.');
  const labels = metric as Record<string, unknown>;
  if (Object.values(labels).some(label => typeof label !== 'string')) throw new ArchiveError('A line of the history has a label that is not text.');
  if (!CHATTER_METRIC.test(String(labels[NAME_LABEL] ?? ''))) throw new ArchiveError('The file has a series that is not a Chatter machine value.');
}

const NEWLINE = 0x0a;

/**
 * The lines of a stream of UTF-8 text, without the empty lines.
 * A line that is longer than maxLineBytes stops the read at once, so a file with no newline cannot fill the memory.
 */
export async function* textLines(source: AsyncIterable<Uint8Array>, maxLineBytes: number): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pendingBytes = 0;
  const tooLong = () => new ArchiveError(`A line of the file is longer than ${maxLineBytes} bytes.`);
  for await (const piece of source) {
    const bytes = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
    let start = 0;
    for (let end = bytes.indexOf(NEWLINE); end >= 0; end = bytes.indexOf(NEWLINE, start)) {
      if (pendingBytes + end - start > maxLineBytes) throw tooLong();
      const line = pending + decoder.write(bytes.subarray(start, end));
      pending = '';
      pendingBytes = 0;
      if (line.length > 0) yield line;
      start = end + 1;
    }
    pendingBytes += bytes.length - start;
    if (pendingBytes > maxLineBytes) throw tooLong();
    pending += decoder.write(bytes.subarray(start));
  }
  const last = pending + decoder.end();
  if (last.length > 0) yield last;
}
