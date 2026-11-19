import type { TimelineState } from '@local-chatter/shared';
import { api } from './client';

/** One time when the machine had one state and one program. Times are in milliseconds since 1970. */
export interface StateSegment {
  state: TimelineState;
  start: number;
  end: number;
  /** The alarm code and text of an alarm */
  detail?: string;
  /** The program that was open, when the machine sent one */
  program?: string;
}

/**
 * What the machine did over a range: running, idle, alarm, or offline, oldest first.
 * `range` is how far back, for example "-24h". The segments cover the full range with no gaps.
 */
export async function fetchStateTimeline(machineId: string, range: string): Promise<StateSegment[]> {
  const response = await api.machine[':id']['state-timeline'].$get({ param: { id: machineId }, query: { range } });
  if (!response.ok) throw new Error('Could not load the machine state history');
  const body = await response.json();
  return body.data.map(({ start, end, ...rest }) => ({ ...rest, start: Date.parse(start), end: Date.parse(end) }));
}
