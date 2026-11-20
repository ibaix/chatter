import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { useNow } from '../../hooks/useNow';
import { CHART_CLOCK_TICK_MS, type ChartRange, type HistoryStatus } from './historyChart';
import { clipSegments, withLiveState, type LiveState, type StateSegment } from './stateTimeline';

/** The timelines that load now. Two charts that ask for the same timeline at the same time share one request. */
const loading = new Map<string, Promise<StateSegment[]>>();

/**
 * Loads a timeline, or joins the request for it that is already open.
 * Until the user zooms, the overview strip and the chart show the same time, so the server reads it once.
 */
function sharedTimeline(key: string, machineId: string, query: string, end: number | null): Promise<StateSegment[]> {
  let request = loading.get(key);
  if (!request) {
    request = (end === null ? fetchStateTimeline(machineId, query) : fetchStateTimeline(machineId, query, end))
      .finally(() => loading.delete(key));
    loading.set(key, request);
  }
  return request;
}

/**
 * The machine state over the chart's range: the saved timeline first, then each live state change.
 * `live` is undefined while the state is not known (the machine connects, or the page lost Chatter). The band then
 * ends where the state was last known, so it does not paint an old state up to now.
 * A new machine or range starts again from no segments, so the old ones never show under the new ones.
 * `clockNow` is the chart's own "now", so a strip under a line ends where the line ends. Without it, the hook keeps its own clock.
 * With an `end`, the band looks back in time: it shows the range before `end`, and no live states.
 */
export function useStateTimeline(
  machineId: string,
  liveState: LiveState | undefined,
  range: ChartRange,
  clockNow?: number,
  end: number | null = null,
) {
  const live = end === null ? liveState : undefined;
  const [segments, setSegments] = useState<StateSegment[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  /** The machine and range that `segments` belong to. Until the effect starts the new ones, the old ones must not show. */
  // The query, not the id: two zooms have the same id but other times
  const key = `${machineId} ${range.query} ${end ?? 'now'}`;
  const [segmentsKey, setSegmentsKey] = useState(key);
  const ownNow = useNow(CHART_CLOCK_TICK_MS);
  const now = end ?? clockNow ?? ownNow;
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
    const request = sharedTimeline(key, machineId, range.query, end);
    request
      .then(loaded => {
        if (stopped) return;
        const current = latestLive.current;
        setSegments(current ? withLiveState(loaded, current) : loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (!stopped) setStatus('failed');
      });
    return () => {
      stopped = true;
      // A request that never ends must not hold up a later chart
      if (loading.get(key) === request) loading.delete(key);
    };
  }, [machineId, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (live) setSegments(known => withLiveState(known, live));
  }, [live?.state, live?.program]);

  const chartNow = Math.max(now, segments[segments.length - 1]?.end ?? 0);
  if (live) lastKnownAt.current = chartNow;
  const lastEnd = end ?? (live ? chartNow : (lastKnownAt.current ?? segments[segments.length - 1]?.end ?? chartNow));
  const shown = useMemo(() => clipSegments(segments, chartNow - range.ms, chartNow, lastEnd), [segments, chartNow, range.ms, lastEnd]);

  if (segmentsKey !== key) return { segments: [], status: 'loading' as const, now: chartNow };
  return { segments: shown, status, now: chartNow };
}
