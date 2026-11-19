import { useEffect, useRef, useState } from 'react';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { useNow } from '../../hooks/useNow';
import type { ChartRange } from './historyChart';
import { clipSegments, withLiveState, type LiveState, type StateSegment } from './stateTimeline';
import type { HistoryStatus } from './useChartHistory';

/** The band moves on this often, also when the state does not change */
const CLOCK_TICK_MS = 5000;

/**
 * The machine state over the chart's range: the saved timeline first, then each live state change.
 * `live` is undefined while the machine connects, so the band does not show a state that is not known.
 */
export function useStateTimeline(machineId: string, live: LiveState | undefined, range: ChartRange) {
  const [segments, setSegments] = useState<StateSegment[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const now = useNow(CLOCK_TICK_MS);
  const latestLive = useRef(live);
  latestLive.current = live;

  useEffect(() => {
    let stopped = false;
    setStatus('loading');
    fetchStateTimeline(machineId, range.query)
      .then(loaded => {
        if (stopped) return;
        const current = latestLive.current;
        setSegments(current ? withLiveState(loaded, current, Date.now()) : loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (!stopped) setStatus('failed');
      });
    return () => { stopped = true; };
  }, [machineId, range]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (live) setSegments(known => withLiveState(known, live, Date.now()));
  }, [live?.state, live?.program]);

  const chartNow = Math.max(now, segments[segments.length - 1]?.end ?? 0);
  return { segments: clipSegments(segments, chartNow - range.ms, chartNow), status, now: chartNow };
}
