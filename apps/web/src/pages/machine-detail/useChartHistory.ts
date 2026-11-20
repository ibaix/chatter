import { autoHistoryWindow, type HistoryValue } from '@local-chatter/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchValueHistory, type HistoryPoint } from '../../api/history';
import {
  durationMs,
  gapFor,
  loadSpan,
  MOVE_LOAD_DELAY_MS,
  mergeHistory,
  pointsFrom,
  withLivePoint,
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
  /** The machine and value that the last load was for, or null before the first load */
  const loadedKey = useRef<string | null>(null);
  /** The range and the end of the last load */
  const loadedRange = useRef<ChartRange | null>(null);
  const loadedEnd = useRef<number | null>(null);
  /** The time each history point covers. Live values are kept one per window of this length. */
  const [windowMs, setWindowMs] = useState(0);
  // The newest live value, so a new range or value starts with it and does not wait for the next one
  const latestLive = useRef(live);
  latestLive.current = live;

  useEffect(() => {
    let stopped = false;
    // Only the end changed: the user moved in time. (StrictMode runs the effect again with the same end.)
    const moved = loadedKey.current === pointsKey && loadedRange.current === range && loadedEnd.current !== end;
    // Another time of the same value keeps the old points until the new ones come
    if (loadedKey.current !== pointsKey) setPoints(latestLive.current ? [latestLive.current] : []);
    loadedKey.current = pointsKey;
    loadedRange.current = range;
    loadedEnd.current = end;
    setShownKey(pointsKey);
    setStatus('loading');
    const load = () => {
      const span = loadSpan(range, end, Date.now());
      const window = range.window ?? autoHistoryWindow(range.ms);
      fetchValueHistory(machineId, value, span.query, window, span.end ?? undefined)
        .then(history => {
          if (stopped) return;
          // A live chart keeps the live values that came while it loaded
          setPoints(known => (end === null ? mergeHistory(history.points, known) : history.points));
          setWindowMs(durationMs(history.window));
          setStatus('ready');
        })
        .catch(() => {
          if (!stopped) setStatus('failed');
        });
    };
    // A move waits, so a quick series of moves loads once. The other loads start after the effect, so StrictMode,
    // which runs each effect twice, sends one request.
    const timer = setTimeout(load, moved ? MOVE_LOAD_DELAY_MS : 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [machineId, value, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (live) setPoints(known => withLivePoint(known, live, windowMs));
  }, [live?.time, live?.value]);

  // A chart in the past ends at `end`
  const chartNow = end ?? clockNow;
  if (shownKey !== pointsKey) return { points: [], status: 'loading' as const, now: chartNow, gapMs: gapFor(windowMs) };
  // The points of the loaded span: the range that shows, and one range before it (loadSpan)
  return { points: pointsFrom(points, chartNow - 2 * range.ms), status, now: chartNow, gapMs: gapFor(windowMs) };
}
