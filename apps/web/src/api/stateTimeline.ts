import type { StateSegment } from '../pages/machine-detail/stateTimeline';
import { api } from './client';

/**
 * What the machine did over a range: running, idle, alarm, or offline, oldest first.
 * `range` is how far back, for example "-24h". The segments cover the full range with no gaps.
 */
export async function fetchStateTimeline(machineId: string, range: string): Promise<StateSegment[]> {
  const response = await api.machine[':id']['state-timeline'].$get({ param: { id: machineId }, query: { range } });
  if (!response.ok) throw new Error('Could not load the machine state history');
  const body = await response.json();
  return body.data.map(segment => ({
    state: segment.state,
    start: Date.parse(segment.start),
    end: Date.parse(segment.end),
    ...('detail' in segment && segment.detail !== undefined ? { detail: segment.detail } : {}),
  }));
}
