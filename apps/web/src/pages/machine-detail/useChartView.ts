import { useState, type Dispatch, type SetStateAction } from 'react';
import { useNow } from '../../hooks/useNow';
import type { Machine } from '../../types';
import { CHART_CLOCK_TICK_MS, CHART_RANGES, fittedOverviewEnd, pannedEnd, zoomView, type ChartRange } from './historyChart';

/** The time in the chart, and the time in the overview strip under it */
export interface ChartView {
  /** The range button that the user picked last: the strip shows this much time */
  overview: ChartRange;
  /** The end of the strip, or null for a strip that ends now */
  overviewEnd: number | null;
  /** The time in the chart: a range button, or a zoom */
  range: ChartRange;
  /** The end of the chart, or null for the live chart that ends now */
  end: number | null;
}

/**
 * A change of the time in the chart. `now` is the time of the change. The caller reads the clock, so the reducer
 * gives the same view each time that React calls it.
 */
type ChartViewAction =
  | { type: 'pick'; range: ChartRange }
  | { type: 'move'; deltaMs: number; now: number }
  | { type: 'now'; now: number }
  | { type: 'zoom'; from: number; to: number; now: number }
  | { type: 'clearZoom'; now: number };

/** The live view of a range button: the chart and the strip show the same time, up to now */
function liveView(range: ChartRange): ChartView {
  return { overview: range, overviewEnd: null, range, end: null };
}

/** The view with another time in the chart. The overview strip moves with it only when the time goes out of the strip. */
function show(view: ChartView, range: ChartRange, end: number | null, now: number): ChartView {
  return { ...view, range, end, overviewEnd: fittedOverviewEnd(view.overviewEnd, view.overview.ms, end, range.ms, now) };
}

/** The end of the strip at `now`. A live strip moves on with the time, so it can move past a view in the past. */
function fittedStrip(view: ChartView, now: number): number | null {
  return fittedOverviewEnd(view.overviewEnd, view.overview.ms, view.end, view.range.ms, now);
}

export function chartViewReducer(view: ChartView, action: ChartViewAction): ChartView {
  switch (action.type) {
    case 'pick':
      return liveView(action.range);
    case 'move':
      return show(view, view.range, pannedEnd(view.end, action.deltaMs, action.now), action.now);
    case 'now':
      return show(view, view.range, null, action.now);
    case 'zoom': {
      const zoomed = zoomView(action.from, action.to, action.now);
      return show(view, zoomed.range, zoomed.end, action.now);
    }
    case 'clearZoom': {
      // The full time of the strip, at the place in time where the strip shows now
      const overviewEnd = fittedStrip(view, action.now);
      return { ...view, overviewEnd, range: view.overview, end: overviewEnd };
    }
  }
}

/** A chart view that a parent keeps (from useState), so the view stays while the chart is not on the page */
export type KeptChartView = [ChartView, Dispatch<SetStateAction<ChartView>>];

/** The view of a new chart: the first range button, up to now */
export function firstChartView(): ChartView {
  return liveView(CHART_RANGES[0]);
}

/**
 * The time in the chart and in the overview strip, and the ways to change it.
 * Without `keptView`, the chart keeps the view itself, and loses it when it leaves the page.
 * `now` is the chart clock (useChartClock). The charts draw "now" from the same clock, so a move or a zoom
 * goes to the time that the user sees.
 */
export function useChartView(now: number, keptView?: KeptChartView) {
  const ownView = useState(firstChartView);
  const [view, setView] = keptView ?? ownView;
  const dispatch = (action: ChartViewAction) => setView(current => chartViewReducer(current, action));
  return {
    /** The strip always holds the view: a live strip that moved past a view in the past goes back to it */
    view: { ...view, overviewEnd: fittedStrip(view, now) },
    /** Shows the last `range` up to now, in the chart and in the strip */
    pick: (range: ChartRange) => dispatch({ type: 'pick', range }),
    /** Moves the time of the chart by `deltaMs`: negative goes back. It cannot go after now. */
    moveBy: (deltaMs: number) => dispatch({ type: 'move', deltaMs, now }),
    /** Moves the time of the chart by a part of its range: -0.5 goes back half the range */
    pan: (step: number) => dispatch({ type: 'move', deltaMs: step * view.range.ms, now }),
    /** Shows the chart's range up to now */
    showNow: () => dispatch({ type: 'now', now }),
    /** Shows the time that the user highlighted. The range buttons and the clear button show the wider times again. */
    zoomTo: (from: number, to: number) => dispatch({ type: 'zoom', from, to, now }),
    clearZoom: () => dispatch({ type: 'clearZoom', now }),
    /** True while the chart shows a zoom, not the full time of the strip */
    zoomed: view.range !== view.overview,
  };
}

/**
 * The "now" of the history charts. All the parts of a chart (the line, the bands, the overview strip, a drag, a move
 * and a zoom) use this one clock, so they agree about where "now" is.
 * It ticks every CHART_CLOCK_TICK_MS. When the clock of Chatter is ahead of the page clock, it is the time of the
 * newest value from Chatter, so the chart never ends before its newest value.
 */
export function useChartClock(machine: Machine): number {
  const pageNow = useNow(CHART_CLOCK_TICK_MS);
  const lastPoll = machine.lastPollTime ? Date.parse(machine.lastPollTime) : 0;
  return Math.max(pageNow, Number.isFinite(lastPoll) ? lastPoll : 0);
}
