import { TIMELINE_STATES, type TimelineState } from '@local-chatter/shared';
import { machineStateOf, type MachineState } from '../../machines/machineStatus';
import type { Machine } from '../../types';

/** One time when the machine had one state. Times are in milliseconds since 1970. */
export interface StateSegment {
  state: TimelineState;
  start: number;
  end: number;
  /** The alarm code and text of an alarm */
  detail?: string;
  /** The program that was open, when the machine sent one */
  program?: string;
}

/** What the machine does now, from the live machine events */
export interface LiveState {
  state: TimelineState;
  program?: string;
}

/** The timeline state of a dashboard state. Undefined while the machine connects, because its state is not known yet. */
export function timelineStateOf(state: MachineState): TimelineState | undefined {
  return state === 'connecting' ? undefined : state;
}

/**
 * The live state and program of the machine. Undefined while the machine connects.
 * An offline machine has no program, because its last program is old (the server timeline has none then too).
 */
export function liveStateOf(machine: Machine): LiveState | undefined {
  const state = timelineStateOf(machineStateOf(machine));
  if (!state) return undefined;
  const program = state === 'offline' ? undefined : machine.data.program || undefined;
  return program === undefined ? { state } : { state, program };
}

/**
 * Add a live state that came at `time`. The last state held until then, so its segment ends at `time`.
 * The same state and program as the last ones change nothing: the last segment reaches "now" when the chart draws it.
 */
export function withLiveState(segments: StateSegment[], live: LiveState, time: number): StateSegment[] {
  const last = segments[segments.length - 1];
  if (last?.state === live.state && last.program === live.program) return segments;
  const held = last ? [...segments.slice(0, -1), { ...last, end: Math.max(last.end, time) }] : [];
  return [...held, { ...live, start: time, end: time }];
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
