import { TIMELINE_STATES, type TimelineState } from '@local-chatter/shared';
import type { StateSegment } from '../../api/stateTimeline';
import { machineStateOf, type MachineState } from '../../machines/machineStatus';
import type { Machine } from '../../types';

export type { StateSegment };

/** What the machine does now, from the live machine events */
export interface LiveState {
  state: TimelineState;
  program?: string;
  /** When the server saw it. The server's clock, the same as the saved timeline, so the two do not overlap. */
  time: number;
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
  const time = machine.lastPollTime ? Date.parse(machine.lastPollTime) : Date.now();
  return program === undefined ? { state, time } : { state, program, time };
}

/**
 * Add a live state that came at `live.time`. The last state held until then, so its segment ends then.
 * The same state and program as the last ones change nothing: the last segment reaches "now" when the chart draws it.
 * The change never starts before the last segment starts, and the last segment never goes past the change,
 * so two segments never overlap, also when the clocks of the server and the browser are not the same.
 */
export function withLiveState(segments: StateSegment[], live: LiveState): StateSegment[] {
  const last = segments[segments.length - 1];
  if (last?.state === live.state && last.program === live.program) return segments;
  const at = last ? Math.max(live.time, last.start) : live.time;
  const held = last ? [...segments.slice(0, -1), { ...last, end: at }] : [];
  const added: StateSegment = live.program === undefined ? { state: live.state, start: at, end: at } : { state: live.state, program: live.program, start: at, end: at };
  return [...held, added];
}

/**
 * The segments from `from` to `now`. The last state holds until `lastEnd` (now, by default), because the live events
 * tell when it changes. When the live state is not known now, `lastEnd` is the last time it was known.
 * The last segment stays also when it has no length yet: it is the state now, which just changed.
 */
export function clipSegments(segments: StateSegment[], from: number, now: number, lastEnd = now): StateSegment[] {
  const lastIndex = segments.length - 1;
  return segments
    .map((segment, index) => ({
      ...segment,
      start: Math.max(segment.start, from),
      end: index === lastIndex ? Math.max(Math.min(lastEnd, now), segment.start) : Math.min(segment.end, now),
    }))
    .filter((segment, index) => segment.end > segment.start || (index === lastIndex && segment.end >= from));
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

/** The segment at a time, for the hover box. The last segment includes its end, which is the newest live time. */
export function segmentAt(segments: StateSegment[], time: number): StateSegment | undefined {
  const last = segments[segments.length - 1];
  return segments.find(segment => segment.start <= time && (time < segment.end || (segment === last && time === segment.end)));
}

/** The start and the end of a segment for the hover box. The end has its date too when it is on another day. */
export function segmentTimesText(start: number, end: number): string {
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return `${new Date(start).toLocaleString()} – ${sameDay ? new Date(end).toLocaleTimeString() : new Date(end).toLocaleString()}`;
}
