import { TIMELINE_STATES, type TimelineState } from '@local-chatter/shared';
import type { MachineState } from '../../machines/machineStatus';

/** One time when the machine had one state. Times are in milliseconds since 1970. */
export interface StateSegment {
  state: TimelineState;
  start: number;
  end: number;
  /** The alarm code and text of an alarm */
  detail?: string;
}

/** The timeline state of a dashboard state. Undefined while the machine connects, because its state is not known yet. */
export function timelineStateOf(state: MachineState): TimelineState | undefined {
  return state === 'connecting' ? undefined : state;
}

/**
 * Add a live state that came at `time`. The last state held until then, so its segment ends at `time`.
 * The same state as the last one changes nothing: the last segment reaches "now" when the chart draws it.
 */
export function withLiveState(segments: StateSegment[], state: TimelineState, time: number): StateSegment[] {
  const last = segments[segments.length - 1];
  if (last?.state === state) return segments;
  const held = last ? [...segments.slice(0, -1), { ...last, end: Math.max(last.end, time) }] : [];
  return [...held, { state, start: time, end: time }];
}

/** The segments from `from` to `now`. The last state holds until now, because the live events tell when it changes. */
export function clipSegments(segments: StateSegment[], from: number, now: number): StateSegment[] {
  return segments
    .map((segment, index) => ({
      ...segment,
      start: Math.max(segment.start, from),
      end: index === segments.length - 1 ? now : Math.min(segment.end, now),
    }))
    .filter(segment => segment.end > segment.start);
}

export interface StateTotal {
  state: TimelineState;
  ms: number;
}

/** The time in each state, in the order of the legend: running, idle, alarm, offline */
export function stateTotals(segments: StateSegment[]): StateTotal[] {
  return TIMELINE_STATES.map(state => ({
    state,
    ms: segments.filter(segment => segment.state === state).reduce((sum, segment) => sum + segment.end - segment.start, 0),
  }));
}

/** The segment at a time, for the hover box */
export function segmentAt(segments: StateSegment[], time: number): StateSegment | undefined {
  return segments.find(segment => segment.start <= time && time < segment.end);
}
