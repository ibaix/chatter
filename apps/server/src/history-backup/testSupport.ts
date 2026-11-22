import type { HistoryPoint, HistorySource, RangeQuery, StateTime, WindowQuery } from '../recording/MetricsReader.js';
import { minuteAverageName } from '../recording/MetricsReader.js';
import { EXPORT_ROWS_PER_LINE } from './archive.js';
import type { ExportRange, HistoryStore } from './victoriaHistory.js';

type Labels = Record<string, string>;

const MINUTE_MS = 60_000;
/** The fake gives its export in pieces of this size, so a line is often split between pieces */
const PIECE_BYTES = 1000;
/** The samples in one block of an unmerged export */
const UNMERGED_BLOCK = 7;

/**
 * For tests: VictoriaMetrics in memory, with the deduplication that docker-compose.yml turns on
 * (-dedup.minScrapeInterval=1ms): a series keeps one sample for each time, the largest value.
 * It is also a simple HistorySource, so the charts and the report can read it.
 */
export class FakeVictoria implements HistoryStore, HistorySource {
  private readonly series = new Map<string, { labels: Labels; samples: Map<number, number> }>();
  importDoneCount = 0;
  importRequests = 0;

  add(labels: Labels, time: number, value: number): void {
    const key = JSON.stringify(Object.entries(labels).sort());
    const series = this.series.get(key) ?? { labels: { ...labels }, samples: new Map<number, number>() };
    this.series.set(key, series);
    series.samples.set(time, Math.max(value, series.samples.get(time) ?? -Infinity));
  }

  /** All the samples of a machine, as sorted text lines, to compare two machines */
  samplesOf(machineId: string): string[] {
    return [...this.series.values()]
      .filter(series => series.labels.machine === machineId)
      .flatMap(series => [...series.samples].map(([time, value]) => `${series.labels.__name__} ${series.labels.type} ${time} ${value}`))
      .sort();
  }

  removeMachine(machineId: string): void {
    for (const [key, series] of this.series) if (series.labels.machine === machineId) this.series.delete(key);
  }

  /**
   * As VictoriaMetrics with reduce_mem_usage=1 can export, when its data is not merged yet: a series in many small blocks,
   * the blocks not in time order, and some samples two times
   */
  unmergedExport = false;

  async exportSeries(machineId: string, namePattern: string, { from, to }: ExportRange): Promise<AsyncIterable<Uint8Array>> {
    const name = new RegExp(`^(?:${namePattern})$`);
    const lines: string[] = [];
    for (const { labels, samples } of this.series.values()) {
      if (labels.machine !== machineId || !name.test(labels.__name__)) continue;
      const inRange = [...samples].filter(([time]) => (from === null || time >= from) && time <= to).sort(([a], [b]) => a - b);
      const size = this.unmergedExport ? UNMERGED_BLOCK : EXPORT_ROWS_PER_LINE;
      const blocks: [number, number][][] = [];
      for (let start = 0; start < inRange.length; start += size) blocks.push(inRange.slice(start, start + size));
      if (this.unmergedExport && blocks.length > 0) {
        blocks.reverse();
        blocks.push(blocks[0].slice(0, 2), blocks[blocks.length - 1]);
      }
      for (const block of blocks) {
        lines.push(JSON.stringify({ metric: labels, values: block.map(([, value]) => value), timestamps: block.map(([time]) => time) }));
      }
    }
    const bytes = Buffer.from(lines.map(line => `${line}\n`).join(''), 'utf8');
    return (async function* () {
      for (let at = 0; at < bytes.length; at += PIECE_BYTES) yield bytes.subarray(at, at + PIECE_BYTES);
    })();
  }

  async importLines(body: string): Promise<void> {
    this.importRequests += 1;
    for (const line of body.split('\n').filter(Boolean)) {
      const { metric, values, timestamps } = JSON.parse(line) as { metric: Labels; values: number[]; timestamps: number[] };
      timestamps.forEach((time, index) => this.add(metric, time, values[index]));
    }
  }

  async importDone(): Promise<void> {
    this.importDoneCount += 1;
  }

  async hasSamples(machineId: string, from: number, to: number): Promise<boolean> {
    return [...this.series.values()].some(series => series.labels.machine === machineId && [...series.samples.keys()].some(time => time >= from && time <= to));
  }

  async windowAverages({ metric, machineId, from, to, windowMs }: WindowQuery): Promise<HistoryPoint[]> {
    const points: HistoryPoint[] = [];
    for (let start = from; start < to; start += windowMs) {
      const values = this.valuesIn(metric, machineId, start, start + windowMs);
      if (values.length > 0) points.push({ time: start, value: values.reduce((sum, value) => sum + value, 0) / values.length });
    }
    return points;
  }

  async stateTime({ metric, machineId, from, to }: RangeQuery): Promise<StateTime | null> {
    const minutes = this.valuesIn(minuteAverageName(metric), machineId, from + 1, to + 1);
    if (minutes.length === 0) return null;
    return { onMs: minutes.reduce((sum, value) => sum + value, 0) * MINUTE_MS, knownMs: minutes.length * MINUTE_MS };
  }

  async rangeIncrease({ metric, machineId, from, to }: RangeQuery): Promise<number | null> {
    const values = this.valuesIn(metric, machineId, from, to + 1);
    return values.length === 0 ? null : values[values.length - 1] - values[0];
  }

  /** The values of one metric of a machine in [from, to), in time order */
  valuesIn(name: string, machineId: string, from: number, to: number): number[] {
    return [...this.series.values()]
      .filter(series => series.labels.__name__ === name && series.labels.machine === machineId)
      .flatMap(series => [...series.samples])
      .filter(([time]) => time >= from && time < to)
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value);
  }
}

/**
 * For tests: some hours of history of one machine, every 2 seconds, with the minute averages and one hour average.
 * The machine runs in the first half of each 10 minutes, and makes one part each minute while it runs.
 */
export function addHistory(victoria: FakeVictoria, machine: { id: string; type: string }, from: number, to: number): void {
  const labels = (name: string) => ({ __name__: name, machine: machine.id, type: machine.type });
  let parts = 0;
  for (let time = from; time < to; time += 2000) {
    const running = Math.floor((time - from) / (5 * MINUTE_MS)) % 2 === 0 ? 1 : 0;
    if (running && (time - from) % MINUTE_MS === 0) parts += 1;
    victoria.add(labels('chatter_connected'), time, 1);
    victoria.add(labels('chatter_running'), time, running);
    victoria.add(labels('chatter_spindle_speed'), time, running ? 8000 + ((time / 2000) % 7) * 10 : 0);
    victoria.add(labels('chatter_part_count'), time, parts);
  }
  // As vmalert saves them: at each minute, avg_over_time of the minute before it, (minute - 1m, minute]
  for (const name of ['chatter_connected', 'chatter_running', 'chatter_spindle_speed', 'chatter_part_count']) {
    for (let minute = from + MINUTE_MS; minute <= to; minute += MINUTE_MS) {
      const values = victoria.valuesIn(name, machine.id, minute - MINUTE_MS + 1, minute + 1);
      if (values.length > 0) victoria.add(labels(`${name}:avg1m`), minute, values.reduce((sum, value) => sum + value, 0) / values.length);
    }
  }
  victoria.add(labels('chatter_running:avg1h'), to, 0.5);
}

/** For tests: the imports wait until release(). `started` resolves at the first import. */
export function holdImports(store: HistoryStore): { started: Promise<void>; release: () => void } {
  const importLines = store.importLines.bind(store);
  let release = () => {};
  const free = new Promise<void>(resolve => {
    release = resolve;
  });
  let started = () => {};
  const startedPromise = new Promise<void>(resolve => {
    started = resolve;
  });
  store.importLines = async body => {
    started();
    await free;
    return importLines(body);
  };
  return { started: startedPromise, release };
}
