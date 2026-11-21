import { autoHistoryWindow, type HistoryValue } from '@local-chatter/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchValueHistory, type HistoryPoint } from '../../api/history';
import {
  compareLoad,
  durationMs,
  gapFor,
  loadSpan,
  mergeHistory,
  pointsFrom,
  withLivePoint,
  type ChartLoad,
  type ChartRange,
  type HistoryStatus,
} from './historyChart';

/**
 * One value over the chart's range: the saved history first, then each live value.
 * The live values come from the live machine events, so the chart does not ask the server again.
 * With an `end`, the chart looks back in time: it shows the range before `end`, and no live values.
 * It loads one more range on each side (loadSpan), so a drag shows data at once. While a new time loads,
 * the old points stay: they have their own times, so they show at the right place.
 * `clockNow` is the chart clock (useChartClock): the end of the live chart.
 */
export function useChartHistory(
  machineId: string,
  value: HistoryValue,
  liveValue: HistoryPoint | null,
  range: ChartRange,
  end: number | null,
  clockNow: number,
) {
  const live = end === null ? liveValue : null;
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  /** The machine and value that `points` belong to. Until the effect starts a new value, the old points must not show. */
  const pointsKey = `${machineId} ${value}`;
  const [shownKey, setShownKey] = useState(pointsKey);
  /** The machine and value, the range and the end of the last load, or null before the first load */
  const lastLoad = useRef<ChartLoad | null>(null);
  /** The time each history point covers. Live values are kept one per window of this length. */
  const [windowMs, setWindowMs] = useState(0);
  // The newest live value, so a new range or value starts with it and does not wait for the next one
  const latestLive = useRef(live);
  latestLive.current = live;
  /** The live values since the last load started. A live chart adds them after the loaded history. */
  const liveSinceLoad = useRef<HistoryPoint[]>([]);

  useEffect(() => {
    let stopped = false;
    const thisLoad = { key: pointsKey, range, end };
    const { isNewKey, delayMs } = compareLoad(lastLoad.current, thisLoad);
    lastLoad.current = thisLoad;
    // Another time of the same value keeps the old points until the new ones come
    if (isNewKey) setPoints(latestLive.current ? [latestLive.current] : []);
    setShownKey(pointsKey);
    setStatus('loading');
    liveSinceLoad.current = latestLive.current ? [latestLive.current] : [];
    const load = () => {
      const span = loadSpan(range, end, Date.now());
      const window = range.window ?? autoHistoryWindow(range.ms);
      fetchValueHistory(machineId, value, span.query, window, span.end ?? undefined)
        .then(history => {
          if (stopped) return;
          // A live chart adds the live values that came while it loaded. The old points of another time do not stay.
          setPoints(end === null ? mergeHistory(history.points, liveSinceLoad.current) : history.points);
          setWindowMs(durationMs(history.window));
          setStatus('ready');
        })
        .catch(() => {
          if (!stopped) setStatus('failed');
        });
    };
    // A move waits (compareLoad). The other loads start after the effect, so StrictMode,
    // which runs each effect twice, sends one request.
    const timer = setTimeout(load, delayMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [machineId, value, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (!live) return;
    liveSinceLoad.current = withLivePoint(liveSinceLoad.current, live, windowMs);
    setPoints(known => withLivePoint(known, live, windowMs));
  }, [live?.time, live?.value]);

  // A chart in the past ends at `end`
  const chartNow = end ?? clockNow;
  if (shownKey !== pointsKey) return { points: [], status: 'loading' as const, now: chartNow, gapMs: gapFor(windowMs) };
  // The points of the loaded span: the range that shows, and one range before it (loadSpan)
  return { points: pointsFrom(points, chartNow - 2 * range.ms), status, now: chartNow, gapMs: gapFor(windowMs) };
}
