import { useReducer } from 'react';
import { CHART_RANGES, fittedOverviewEnd, pannedEnd, zoomView, type ChartRange } from './historyChart';

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
  | { type: 'clearZoom' };

/** The live view of a range button: the chart and the strip show the same time, up to now */
function liveView(range: ChartRange): ChartView {
  return { overview: range, overviewEnd: null, range, end: null };
}

/** The view with another time in the chart. The overview strip moves with it only when the time goes out of the strip. */
function show(view: ChartView, range: ChartRange, end: number | null, now: number): ChartView {
  return { ...view, range, end, overviewEnd: fittedOverviewEnd(view.overviewEnd, view.overview.ms, end, range.ms, now) };
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
    case 'clearZoom':
      // The full time of the strip, at the place in time where the strip is
      return { ...view, range: view.overview, end: view.overviewEnd };
  }
}

/** The time in the chart and in the overview strip, and the ways to change it */
export function useChartView() {
  const [view, dispatch] = useReducer(chartViewReducer, CHART_RANGES[0], liveView);
  return {
    view,
    /** Shows the last `range` up to now, in the chart and in the strip */
    pick: (range: ChartRange) => dispatch({ type: 'pick', range }),
    /** Moves the time of the chart by `deltaMs`: negative goes back. It cannot go after now. */
    moveBy: (deltaMs: number) => dispatch({ type: 'move', deltaMs, now: Date.now() }),
    /** Moves the time of the chart by a part of its range: -0.5 goes back half the range */
    pan: (step: number) => dispatch({ type: 'move', deltaMs: step * view.range.ms, now: Date.now() }),
    /** Shows the chart's range up to now */
    showNow: () => dispatch({ type: 'now', now: Date.now() }),
    /** Shows the time that the user highlighted. The range buttons and the clear button show the wider times again. */
    zoomTo: (from: number, to: number) => dispatch({ type: 'zoom', from, to, now: Date.now() }),
    clearZoom: () => dispatch({ type: 'clearZoom' }),
    /** True while the chart shows a zoom, not the full time of the strip */
    zoomed: view.range !== view.overview,
  };
}
