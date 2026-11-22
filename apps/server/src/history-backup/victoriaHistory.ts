import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { escapeLabelValue } from '../recording/metricLines.js';
import { EXPORT_ROWS_PER_LINE } from './archive.js';

const EXPORT_PATH = '/api/v1/export';
const IMPORT_PATH = '/api/v1/import';
/** VictoriaMetrics keeps the answers of queries. A restore adds old samples, so the kept answers must go. */
const RESET_CACHE_PATH = '/internal/resetRollupResultCache';
const IMPORT_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** VictoriaMetrics does not answer, or it refuses a request. The route gives 503. */
export class HistoryUnavailableError extends Error {}

/** The raw values of the history (metricLines.ts), and the averages that vmalert saves (vmalert/rules.yml) */
export const RAW_SERIES = 'chatter_[a-z0-9_]+';
export const AVERAGE_SERIES = 'chatter_[a-z0-9_]+:avg1[mh]';

export interface ExportRange {
  /** Null for all the history */
  from: number | null;
  to: number;
}

/** Where a history backup reads the series of a machine, and where a restore writes them */
export interface HistoryStore {
  /** The series of the machine whose name matches the pattern, as lines of /api/v1/export */
  exportSeries(machineId: string, namePattern: string, range: ExportRange, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** Write lines of /api/v1/export (JSON, one series block on each line) */
  importLines(body: string): Promise<void>;
  /** Call after an import, so the charts show the new samples at once */
  importDone(): Promise<void>;
}

/** The machine history in VictoriaMetrics */
export class VictoriaHistory implements HistoryStore {
  constructor(private readonly url: string) {}

  async exportSeries(machineId: string, namePattern: string, { from, to }: ExportRange, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const params = new URLSearchParams({
      'match[]': `{__name__=~"${namePattern}",machine="${escapeLabelValue(machineId)}"}`,
      end: seconds(to),
      max_rows_per_line: String(EXPORT_ROWS_PER_LINE),
      // VictoriaMetrics sends each block as it reads it, and does not hold a whole series in memory first. Then a series
      // can be on many lines, not in time order, and a sample that is not merged yet can come two times. The backup
      // does not need the time order, and the deduplication of the restore keeps one sample for each time.
      reduce_mem_usage: '1',
    });
    if (from !== null) params.set('start', seconds(from));
    // The export itself can take long on a Pi. The time limit stops only a VictoriaMetrics that does not start to answer.
    const controller = new AbortController();
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('VictoriaMetrics did not answer')), CONNECT_TIMEOUT_MS);
    try {
      const response = await answerOf(new URL(`${EXPORT_PATH}?${params}`, this.url), { signal: controller.signal }, signal);
      if (!response.body) throw new HistoryUnavailableError('VictoriaMetrics answered with no body');
      return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    } finally {
      clearTimeout(timer);
    }
  }

  async importLines(body: string): Promise<void> {
    await answerOf(new URL(IMPORT_PATH, this.url), { method: 'POST', body, signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) });
  }

  async importDone(): Promise<void> {
    await answerOf(new URL(RESET_CACHE_PATH, this.url), { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  }
}

/** The answer of VictoriaMetrics. No answer, or an answer that is not OK, is a HistoryUnavailableError. A stop by `stop` is not. */
async function answerOf(url: URL, init: RequestInit, stop?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (stop?.aborted) throw error;
    throw new HistoryUnavailableError(`VictoriaMetrics did not answer: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) throw new HistoryUnavailableError(await describeAnswer(response));
  return response;
}

/** The time in seconds, with milliseconds, as VictoriaMetrics reads it */
function seconds(timeMs: number): string {
  return (timeMs / 1000).toFixed(3);
}

async function describeAnswer(response: Response): Promise<string> {
  return `VictoriaMetrics answered ${response.status}: ${(await response.text()).trim().slice(0, 300)}`;
}
