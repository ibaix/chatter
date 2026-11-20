import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { useNow } from '../../hooks/useNow';
import { CHART_CLOCK_TICK_MS, loadSpan, type ChartRange, type HistoryStatus } from './historyChart';
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
 * It loads one more range on each side (loadSpan), so a drag shows data at once. The segments are of that span.
 * A new machine starts again from no segments. Another time of the same machine keeps the old segments until the new
 * ones come: they have their own times, so they show at the right place.
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
  // The query, not the id: two zooms have the same id but other times
  const key = `${machineId} ${range.query} ${end ?? 'now'}`;
  /** The machine that `segments` belong to. Until the effect starts a new machine, the old segments must not show. */
  const [segmentsMachine, setSegmentsMachine] = useState(machineId);
  /** The machine of the last load, or null before the first load */
  const loadedMachine = useRef<string | null>(null);
  /** True while a load runs. The old segments stay until it ends, so a live state does not stretch them. */
  const loadRuns = useRef(false);
  const ownNow = useNow(CHART_CLOCK_TICK_MS);
  // The newest live state, so a new machine starts with it and does not wait for the next change
  const latestLive = useRef(live);
  latestLive.current = live;
  /** The last time that the live state was known */
  const lastKnownAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    // Another time of the same machine keeps the old segments until the new ones come
    if (loadedMachine.current !== machineId) {
      const startLive = latestLive.current;
      setSegments(startLive ? withLiveState([], startLive) : []);
      lastKnownAt.current = undefined;
    }
    loadedMachine.current = machineId;
    setSegmentsMachine(machineId);
    setStatus('loading');
    loadRuns.current = true;
    const span = loadSpan(range, end, Date.now());
    const request = sharedTimeline(key, machineId, span.query, span.end);
    request
      .then(loaded => {
        if (stopped) return;
        loadRuns.current = false;
        const current = latestLive.current;
        setSegments(current ? withLiveState(loaded, current) : loaded);
        setStatus('ready');
      })
      .catch(() => {
        if (stopped) return;
        loadRuns.current = false;
        setStatus('failed');
      });
    return () => {
      stopped = true;
      // A request that never ends must not hold up a later chart
      if (loading.get(key) === request) loading.delete(key);
    };
  }, [machineId, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change.
  // While a load runs, the load adds the newest live state when it ends.
  useEffect(() => {
    if (live && !loadRuns.current) setSegments(known => withLiveState(known, live));
  }, [live?.state, live?.program]);

  const last = segments[segments.length - 1];
  const chartNow = end ?? Math.max(clockNow ?? ownNow, last?.end ?? 0);
  if (live) lastKnownAt.current = chartNow;
  // The loaded span (loadSpan): one more range before the chart, and for a chart in the past one more range after it
  const spanEnd = end === null ? chartNow : Math.min(end + range.ms, Math.max(ownNow, end));
  const lastEnd = status === 'loading' && last
    // The old segments of another time end where they were loaded
    ? Math.min(last.end, spanEnd)
    : end !== null ? spanEnd : live ? chartNow : (lastKnownAt.current ?? last?.end ?? chartNow);
  const shown = useMemo(
    () => clipSegments(segments, chartNow - 2 * range.ms, spanEnd, lastEnd),
    [segments, chartNow, spanEnd, range.ms, lastEnd],
  );

  if (segmentsMachine !== machineId) return { segments: [], status: 'loading' as const, now: chartNow };
  return { segments: shown, status, now: chartNow };
}
