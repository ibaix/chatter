import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { useNow } from '../../hooks/useNow';
import { CHART_CLOCK_TICK_MS, compareLoad, loadSpan, type ChartLoad, type ChartRange, type HistoryStatus } from './historyChart';
import { clipSegments, withLiveState, type LiveState, type StateSegment } from './stateTimeline';

interface SharedLoad {
  request: Promise<StateSegment[]>;
  /** The number of charts that wait for the request */
  waiting: number;
  /** The timer that starts the request, until it starts */
  timer: ReturnType<typeof setTimeout>;
}

/** The timelines that load now. Two charts that ask for the same timeline at the same time share one request. */
const loading = new Map<string, SharedLoad>();

/**
 * Joins the request for a timeline, or makes it. The request starts after `delayMs`, so all the charts that ask for
 * the same timeline in the same render join it first. Until the user zooms, the overview strip and the chart show
 * the same time, so the server reads it once.
 * Call `leave` when the chart does not wait any more. When no chart waits, the request does not start, and a later
 * chart makes a new one.
 */
function joinTimeline(
  key: string,
  delayMs: number,
  load: () => Promise<StateSegment[]>,
): { request: Promise<StateSegment[]>; leave: () => void } {
  let shared = loading.get(key);
  if (!shared) {
    const made = { waiting: 0 } as SharedLoad;
    made.request = new Promise<StateSegment[]>((resolve, reject) => {
      made.timer = setTimeout(() => load().then(resolve, reject), delayMs);
    }).finally(() => {
      // A newer request for the same key can be in the map now, when all the charts stopped waiting for this one
      if (loading.get(key) === made) loading.delete(key);
    });
    // The request of a chart that stopped waiting can fail. Nobody reads that result.
    made.request.catch(() => {});
    loading.set(key, made);
    shared = made;
  }
  const joined = shared;
  joined.waiting += 1;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    joined.waiting -= 1;
    if (joined.waiting > 0 || loading.get(key) !== joined) return;
    clearTimeout(joined.timer);
    loading.delete(key);
  };
  return { request: joined.request, leave };
}

/**
 * The machine state over the chart's range: the saved timeline first, then each live state change.
 * `live` is undefined while the state is not known (the machine connects, or the page lost Chatter). The band then
 * ends where the state was last known, so it does not paint an old state up to now.
 * It loads one more range on each side (loadSpan), so a drag shows data at once. The segments are of that span.
 * A new machine starts again from no segments. Another time of the same machine keeps the old segments until the new
 * ones come: they have their own times, so they show at the right place.
 * `clockNow` is the chart clock (useChartClock), so all the parts of a chart end at the same "now". Without it, the hook
 * keeps its own clock, and the band goes on to the end of the newest segment.
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
  /** The machine, the range and the end of the last load, or null before the first load */
  const lastLoad = useRef<ChartLoad | null>(null);
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
    const thisLoad = { key: machineId, range, end };
    const { isNewKey, delayMs } = compareLoad(lastLoad.current, thisLoad);
    lastLoad.current = thisLoad;
    // Another time of the same machine keeps the old segments until the new ones come
    if (isNewKey) {
      const startLive = latestLive.current;
      setSegments(startLive ? withLiveState([], startLive) : []);
      lastKnownAt.current = undefined;
    }
    setSegmentsMachine(machineId);
    setStatus('loading');
    loadRuns.current = true;
    // A move waits (compareLoad). The other loads start after the effect, so StrictMode,
    // which runs each effect twice, sends one request.
    const { request, leave } = joinTimeline(key, delayMs, () => {
      const span = loadSpan(range, end, Date.now());
      return fetchStateTimeline(machineId, span.query, span.end ?? undefined);
    });
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
      leave();
    };
  }, [machineId, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change.
  // While a load runs, the load adds the newest live state when it ends.
  useEffect(() => {
    if (live && !loadRuns.current) setSegments(known => withLiveState(known, live));
  }, [live?.state, live?.program]);

  const last = segments[segments.length - 1];
  const clock = clockNow ?? Math.max(ownNow, last?.end ?? 0);
  const chartNow = end ?? clock;
  if (live) lastKnownAt.current = chartNow;
  // The loaded span (loadSpan): one more range before the chart, and for a chart in the past one more range after it
  const spanEnd = end === null ? chartNow : Math.min(end + range.ms, Math.max(clock, end));
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
