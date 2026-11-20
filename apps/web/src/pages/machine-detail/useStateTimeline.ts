import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { useNow } from '../../hooks/useNow';
import { CHART_CLOCK_TICK_MS, type ChartRange, type HistoryStatus } from './historyChart';
import { clipSegments, withLiveState, type LiveState, type StateSegment } from './stateTimeline';

/**
 * The machine state over the chart's range: the saved timeline first, then each live state change.
 * `live` is undefined while the state is not known (the machine connects, or the page lost Chatter). The band then
 * ends where the state was last known, so it does not paint an old state up to now.
 * A new machine or range starts again from no segments, so the old ones never show under the new ones.
 * `clockNow` is the chart's own "now", so a strip under a line ends where the line ends. Without it, the hook keeps its own clock.
 */
export function useStateTimeline(machineId: string, live: LiveState | undefined, range: ChartRange, clockNow?: number) {
  const [segments, setSegments] = useState<StateSegment[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  /** The machine and range that `segments` belong to. Until the effect starts the new ones, the old ones must not show. */
  const key = `${machineId} ${range.id}`;
  const [segmentsKey, setSegmentsKey] = useState(key);
  const ownNow = useNow(CHART_CLOCK_TICK_MS);
  const now = clockNow ?? ownNow;
  // The newest live state, so a new machine or range starts with it and does not wait for the next change
  const latestLive = useRef(live);
  latestLive.current = live;
  /** The last time that the live state was known */
  const lastKnownAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    const startLive = latestLive.current;
    setSegments(startLive ? withLiveState([], startLive) : []);
    setSegmentsKey(key);
    setStatus('loading');
    lastKnownAt.current = undefined;
    fetchStateTimeline(machineId, range.query)
      .then(loaded => {
        if (stopped) return;
        const current = latestLive.current;
        setSegments(current ? withLiveState(loaded, current) : loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (!stopped) setStatus('failed');
      });
    return () => { stopped = true; };
  }, [machineId, range]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (live) setSegments(known => withLiveState(known, live));
  }, [live?.state, live?.program]);

  const chartNow = Math.max(now, segments[segments.length - 1]?.end ?? 0);
  if (live) lastKnownAt.current = chartNow;
  const lastEnd = live ? chartNow : (lastKnownAt.current ?? segments[segments.length - 1]?.end ?? chartNow);
  const shown = useMemo(() => clipSegments(segments, chartNow - range.ms, chartNow, lastEnd), [segments, chartNow, range.ms, lastEnd]);

  if (segmentsKey !== key) return { segments: [], status: 'loading' as const, now: chartNow };
  return { segments: shown, status, now: chartNow };
}
