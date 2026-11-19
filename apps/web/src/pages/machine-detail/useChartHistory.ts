import type { HistoryValue } from '@local-chatter/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchValueHistory, type HistoryPoint } from '../../api/history';
import { useNow } from '../../hooks/useNow';
import {
  CHART_CLOCK_TICK_MS,
  durationMs,
  gapFor,
  mergeHistory,
  recentPoints,
  withLivePoint,
  type ChartRange,
  type HistoryStatus,
} from './historyChart';



/**
 * One value over the chart's range: the saved history first, then each live value.
 * The live values come from the live machine events, so the chart does not ask the server again.
 * With an `end`, the chart looks back in time: it shows the range before `end`, and no live values.
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
  /** The value that `points` belong to. Until the effect starts the new value, the old points must not show. */
  const [pointsValue, setPointsValue] = useState(value);
  /** The time each history point covers. Live values are kept one per window of this length. */
  const [windowMs, setWindowMs] = useState(0);
  const now = useNow(CHART_CLOCK_TICK_MS);
  // The newest live value, so a new range or value starts with it and does not wait for the next one
  const latestLive = useRef(live);
  latestLive.current = live;

  useEffect(() => {
    let stopped = false;
    setPoints(latestLive.current && end === null ? [latestLive.current] : []);
    setPointsValue(value);
    setStatus('loading');
    const loading = end === null
      ? fetchValueHistory(machineId, value, range.query, range.window)
      : fetchValueHistory(machineId, value, range.query, range.window, end);
    loading
      .then(history => {
        if (stopped) return;
        setPoints(livePoints => mergeHistory(history.points, livePoints));
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
  if (pointsValue !== value) return { points: [], status: 'loading' as const, now: chartNow, gapMs: gapFor(windowMs) };
  return { points: recentPoints(points, chartNow, range.ms), status, now: chartNow, gapMs: gapFor(windowMs) };
}
