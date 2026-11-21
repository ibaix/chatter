import { isRunningStateText, type TimelineState } from '@local-chatter/shared';
import type { StatePeriod, StatePeriodStore } from './StatePeriodStore.js';

/**
 * One time when the machine had one state and one program. `detail` is the alarm code and text of an alarm.
 * `program` is the program that was open, when the machine sent one.
 */
export interface TimelineSegment {
  state: TimelineState;
  start: number;
  end: number;
  detail?: string;
  program?: string;
}

/**
 * The machine state from `from` to `to`, made from the saved state periods.
 * The rule is the one of the dashboard (machineStateOf in the web app):
 * - alarm: an alarm period is open. An alarm shows over running.
 * - running: a run-state period means that a program runs (isRunningStateText)
 * - idle: any other period is open, so the machine was connected. A machine that sends no run state
 *   (a Haas with no query port) still has program or tool periods, so it shows idle, not offline.
 * - offline: no period is open. The periods close when the machine stops answering and when Chatter stops.
 * A new program starts a new segment, also when the state stays the same, so each segment has one program.
 */
export function stateTimeline(periods: StatePeriod[], from: number, to: number): TimelineSegment[] {
  const clipped = periods
    .map(period => ({ ...period, start: Math.max(period.start, from), end: Math.min(period.end ?? to, to) }))
    .filter(period => period.start < period.end)
    .sort((a, b) => a.start - b.start);
  const times = [...new Set([from, to, ...clipped.flatMap(period => [period.start, period.end])])].sort((a, b) => a - b);

  // A sweep over the times: `open` holds only the periods open now (a few, one per kind), so 7 days stay fast
  const segments: TimelineSegment[] = [];
  let open: typeof clipped = [];
  let next = 0;
  for (let index = 0; index < times.length - 1; index++) {
    const start = times[index];
    open = open.filter(period => period.end > start);
    while (next < clipped.length && clipped[next].start <= start) open.push(clipped[next++]);
    addSegment(segments, { ...valuesOf(open), start, end: times[index + 1] });
  }
  return segments;
}

type SegmentValues = Pick<TimelineSegment, 'state' | 'detail' | 'program'>;

function valuesOf(open: StatePeriod[]): SegmentValues {
  const program = open.find(period => period.kind === 'program')?.value;
  return { ...stateOf(open), ...(program === undefined ? {} : { program }) };
}

function stateOf(open: StatePeriod[]): Pick<TimelineSegment, 'state' | 'detail'> {
  const alarm = open.find(period => period.kind === 'alarm');
  if (alarm) return { state: 'alarm', detail: alarm.value };
  if (open.some(period => period.kind === 'run-state' && isRunningStateText(period.value))) return { state: 'running' };
  return { state: open.length > 0 ? 'idle' : 'offline' };
}

/** Add the segment, or make the last one longer when it has the same state, alarm and program */
function addSegment(segments: TimelineSegment[], segment: TimelineSegment): void {
  const last = segments[segments.length - 1];
  const same = last && last.state === segment.state && last.detail === segment.detail && last.program === segment.program;
  if (same && last.end === segment.start) {
    last.end = segment.end;
    return;
  }
  segments.push(segment);
}

/** More periods than this are open at one time only on a broken machine. One per kind is normal. */
const MAX_OPEN_AT_ONE_TIME = 100;

export interface TimelineRead {
  periods: StatePeriod[];
  /** Where the timeline starts. Later than the start of the range when `more` is true. */
  from: number;
  /** True when the range had more than `limit` periods, so the older part is left out */
  more: boolean;
}

/**
 * The periods for the state timeline from `from` to `to`, at most `limit` of the newest ones.
 * With more, the timeline starts at the oldest period read (never before `from`). A long period of another kind
 * that is open then (for example a run state open for days while the tool changes often) is read on its own,
 * because the limit can leave it out.
 */
export function readTimelinePeriods(
  store: StatePeriodStore,
  { machineId, from, to, limit }: { machineId: string; from: number; to: number; limit: number },
): TimelineRead {
  const found = store.read({ machineId, from, to, limit: limit + 1 });
  if (found.length <= limit) return { periods: found, from, more: false };

  const read = found.slice(0, limit);
  const cut = Math.max(read[read.length - 1]?.start ?? from, from);
  const openAtCut = store.read({ machineId, from: cut, to: cut + 1, limit: MAX_OPEN_AT_ONE_TIME });
  const keyOf = (period: StatePeriod) => `${period.kind} ${period.start} ${period.value}`;
  const known = new Set(read.map(keyOf));
  return { periods: [...read, ...openAtCut.filter(period => !known.has(keyOf(period)))], from: cut, more: true };
}
