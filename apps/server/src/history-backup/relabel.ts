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

/** Where the samples of a restore go, and the times that the history can keep */
export interface RelabelTarget {
  machineId: string;
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
 * The line with the machine label of the target machine. No other label changes.
 * Refuses a line that is not a chatter_* series of the same machine type, and a sample in the future.
 */
export function relabelLine(text: string, target: RelabelTarget): RelabelledLine {
  const series = parseSeries(text);
  if (series.metric[TYPE_LABEL] !== target.machineType) throw new ArchiveError('The file has history of another machine type.');
  const keep = series.timestamps.map(time => time >= target.notBefore);
  if (series.timestamps.some(time => time > target.notAfter)) throw new ArchiveError('The file has history with a time in the future.');
  const samples = keep.filter(Boolean).length;
  const tooOld = keep.length - samples;
  if (samples === 0) return { line: null, samples, tooOld };
  const relabelled: ExportedSeries = {
    metric: { ...series.metric, [MACHINE_LABEL]: target.machineId },
    values: tooOld === 0 ? series.values : series.values.filter((_value, index) => keep[index]),
    timestamps: tooOld === 0 ? series.timestamps : series.timestamps.filter((_time, index) => keep[index]),
  };
  return { line: JSON.stringify(relabelled), samples, tooOld };
}

/** The sample count and the first and last time of an exported line, for the manifest */
export function sampleFacts(text: string): { samples: number; first: number | null; last: number | null } {
  const { timestamps } = parseSeries(text);
  if (timestamps.length === 0) return { samples: 0, first: null, last: null };
  let first = timestamps[0];
  let last = timestamps[0];
  for (const time of timestamps) {
    if (time < first) first = time;
    if (time > last) last = time;
  }
  return { samples: timestamps.length, first, last };
}

function parseSeries(text: string): ExportedSeries {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArchiveError('A line of the history is not JSON.');
  }
  const { metric, values, timestamps } = (value ?? {}) as Partial<ExportedSeries>;
  if (typeof metric !== 'object' || metric === null || Array.isArray(metric)) throw new ArchiveError('A line of the history has no metric.');
  if (Object.values(metric).some(label => typeof label !== 'string')) throw new ArchiveError('A line of the history has a label that is not text.');
  if (!CHATTER_METRIC.test(metric[NAME_LABEL] ?? '')) throw new ArchiveError('The file has a series that is not a Chatter machine value.');
  if (!Array.isArray(values) || !Array.isArray(timestamps) || values.length !== timestamps.length) {
    throw new ArchiveError('A line of the history has not the same number of values and times.');
  }
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item))) throw new ArchiveError('A line of the history has a value that is not a number.');
  if (!timestamps.every(item => Number.isSafeInteger(item) && item >= 0)) throw new ArchiveError('A line of the history has a time that is not correct.');
  return { metric, values, timestamps };
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
