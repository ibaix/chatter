import { autoHistoryWindow, type HistoryValue } from '@local-chatter/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchValueHistory, type HistoryPoint } from '../../api/history';
import { useNow } from '../../hooks/useNow';
import {
  CHART_CLOCK_TICK_MS,
  durationMs,
  gapFor,
  loadSpan,
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
 */
export function useChartHistory(
  machineId: string,
  value: HistoryValue,
  liveValue: HistoryPoint | null,
  range: ChartRange,
  end: number | null = null,
) {
  const live = end === null ? liveValue : null;
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  /** The machine and value that `points` belong to. Until the effect starts a new value, the old points must not show. */
  const pointsKey = `${machineId} ${value}`;
  const [shownKey, setShownKey] = useState(pointsKey);
  /** The machine and value that the last load was for, or null before the first load */
  const loadedKey = useRef<string | null>(null);
  /** The time each history point covers. Live values are kept one per window of this length. */
  const [windowMs, setWindowMs] = useState(0);
  const now = useNow(CHART_CLOCK_TICK_MS);
  // The newest live value, so a new range or value starts with it and does not wait for the next one
  const latestLive = useRef(live);
  latestLive.current = live;

  useEffect(() => {
    let stopped = false;
    // Another time of the same value keeps the old points until the new ones come
    if (loadedKey.current !== pointsKey) setPoints(latestLive.current ? [latestLive.current] : []);
    loadedKey.current = pointsKey;
    setShownKey(pointsKey);
    setStatus('loading');
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
    return () => { stopped = true; };
  }, [machineId, value, range, end]);

  // `live` is a new object on each render, so the effect runs only when its values change
  useEffect(() => {
    if (live) setPoints(known => withLivePoint(known, live, windowMs));
  }, [live?.time, live?.value]);

  // The newest time that is known, so the chart never shows a value after "now". A chart in the past ends at `end`.
  const chartNow = end ?? Math.max(now, live?.time ?? 0);
  if (shownKey !== pointsKey) return { points: [], status: 'loading' as const, now: chartNow, gapMs: gapFor(windowMs) };
  // The points of the loaded span: the range that shows, and one range before it (loadSpan)
  return { points: pointsFrom(points, chartNow - 2 * range.ms), status, now: chartNow, gapMs: gapFor(windowMs) };
}
