import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CHART_RANGES } from './historyChart';
import { chartHistoryReducer, firstChartHistory, useChartView } from './useChartView';

const NOW = Date.parse('2026-11-19T15:00:00.000Z');
const MINUTE = 60_000;

function renderChartView() {
  return renderHook(({ now }: { now: number }) => useChartView(now), { initialProps: { now: NOW } });
}

describe('useChartView', () => {
  it('moves a live strip back to a zoom in the past when the time goes on, so the strip keeps the box', () => {
    const { result, rerender } = renderChartView();
    act(() => result.current.zoomTo(NOW - 9 * MINUTE, NOW - 8 * MINUTE));
    expect(result.current.view.overviewEnd).toBeNull();

    // 5 minutes later, the live 10-minute strip starts after the zoom
    rerender({ now: NOW + 5 * MINUTE });

    // The zoom is at the left end of the strip
    expect(result.current.view.overviewEnd).toBe(NOW - 9 * MINUTE + 10 * MINUTE);
    expect(result.current.view.end).toBe(NOW - 8 * MINUTE);
  });

  it('clears the zoom to the time of the strip that shows', () => {
    const { result, rerender } = renderChartView();
    act(() => result.current.zoomTo(NOW - 9 * MINUTE, NOW - 8 * MINUTE));
    rerender({ now: NOW + 5 * MINUTE });

    act(() => result.current.clearZoom());

    expect(result.current.zoomed).toBe(false);
    expect(result.current.view.end).toBe(NOW + MINUTE);
  });

  describe('accepting a zoom', () => {
    it('makes the zoom the full range of the chart: the chart is not zoomed, and the strip shows the zoom', () => {
      const { result } = renderChartView();
      act(() => result.current.zoomTo(NOW - 9 * MINUTE, NOW - 7 * MINUTE));
      const zoomedView = result.current.view;

      act(() => result.current.acceptZoom());

      expect(result.current.zoomed).toBe(false);
      expect(result.current.view.overview).toBe(zoomedView.range);
      expect(result.current.view.range).toBe(zoomedView.range);
      expect(result.current.view.overviewEnd).toBe(zoomedView.end);
      expect(result.current.view.end).toBe(zoomedView.end);
    });

    it('keeps an accepted zoom that ends now live when the time goes on', () => {
      const { result, rerender } = renderChartView();
      act(() => result.current.zoomTo(NOW - 2 * MINUTE, NOW));
      act(() => result.current.acceptZoom());

      rerender({ now: NOW + 5 * MINUTE });

      expect(result.current.view.end).toBeNull();
      expect(result.current.view.overviewEnd).toBeNull();
      expect(result.current.zoomed).toBe(false);
    });

    it('does not zoom in on a strip that has the shortest zoom: the chart only moves', () => {
      const { result } = renderChartView();
      // The shortest zoom is 30 seconds
      act(() => result.current.zoomTo(NOW - 5 * MINUTE, NOW - 5 * MINUTE + 1000));
      act(() => result.current.acceptZoom());
      const strip = result.current.view.overview;

      act(() => result.current.zoomTo(NOW - 5 * MINUTE + 10_000, NOW - 5 * MINUTE + 11_000));

      expect(result.current.zoomed).toBe(false);
      expect(result.current.view.range).toBe(strip);
      expect(result.current.view.end).toBe(NOW - 5 * MINUTE + 10_500 + 15_000);
    });
  });

  describe('undo and redo', () => {
    it('can undo or redo nothing at the start', () => {
      const { result } = renderChartView();

      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });

    it('goes back and on through a range button, a zoom and an accepted zoom', () => {
      const { result } = renderChartView();
      act(() => result.current.pick(CHART_RANGES[1]));
      act(() => result.current.zoomTo(NOW - 40 * MINUTE, NOW - 20 * MINUTE));
      const zoomedView = result.current.view;
      act(() => result.current.acceptZoom());
      const acceptedView = result.current.view;

      act(() => result.current.undo());
      expect(result.current.view).toEqual(zoomedView);
      expect(result.current.zoomed).toBe(true);
      act(() => result.current.undo());
      expect(result.current.view.range).toBe(CHART_RANGES[1]);
      expect(result.current.zoomed).toBe(false);
      act(() => result.current.undo());
      expect(result.current.view.range).toBe(CHART_RANGES[0]);
      expect(result.current.canUndo).toBe(false);

      act(() => result.current.redo());
      act(() => result.current.redo());
      act(() => result.current.redo());
      expect(result.current.view).toEqual(acceptedView);
      expect(result.current.zoomed).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });

    it('makes one entry of the moves in a row, so one undo goes back before all of them', () => {
      const { result } = renderChartView();
      for (let move = 0; move < 3; move++) act(() => result.current.moveBy(-MINUTE));
      expect(result.current.view.end).toBe(NOW - 3 * MINUTE);

      act(() => result.current.undo());

      expect(result.current.view.end).toBeNull();
      expect(result.current.canUndo).toBe(false);
    });

    it('makes a new entry for a move after an undo, and clears the redo', () => {
      const { result } = renderChartView();
      act(() => result.current.moveBy(-MINUTE));
      act(() => result.current.moveBy(-MINUTE));
      act(() => result.current.undo());
      expect(result.current.canRedo).toBe(true);

      act(() => result.current.moveBy(-5 * MINUTE));
      act(() => result.current.moveBy(-MINUTE));

      expect(result.current.canRedo).toBe(false);
      act(() => result.current.undo());
      expect(result.current.view.end).toBeNull();
      expect(result.current.canUndo).toBe(false);
    });

    it('clears the redo after a new change', () => {
      const { result } = renderChartView();
      act(() => result.current.pick(CHART_RANGES[1]));
      act(() => result.current.undo());

      act(() => result.current.pick(CHART_RANGES[2]));

      expect(result.current.canRedo).toBe(false);
      expect(result.current.canUndo).toBe(true);
    });

    it('makes no entry for a change that does not change the view, such as Now on the live chart', () => {
      const { result } = renderChartView();

      act(() => result.current.showNow());
      act(() => result.current.pick(CHART_RANGES[0]));

      expect(result.current.canUndo).toBe(false);
    });

    it('keeps the live chart live after an undo, also when the time went on', () => {
      const { result, rerender } = renderChartView();
      act(() => result.current.moveBy(-5 * MINUTE));
      rerender({ now: NOW + 3 * MINUTE });

      act(() => result.current.undo());

      expect(result.current.view.end).toBeNull();
    });

    it('keeps at most 50 entries, and drops the oldest', () => {
      const ranges = [CHART_RANGES[1], CHART_RANGES[2]];
      let history = firstChartHistory();
      for (let change = 0; change < 60; change++) history = chartHistoryReducer(history, { type: 'pick', range: ranges[change % 2] });
      expect(history.past).toHaveLength(50);

      for (let undo = 0; undo < 60; undo++) history = chartHistoryReducer(history, { type: 'undo' });

      expect(history.past).toHaveLength(0);
      expect(history.future).toHaveLength(50);
      // The first view (10 minutes) and the first 9 changes are gone: the oldest view is the 10th change
      expect(history.present.range).toBe(ranges[9 % 2]);
    });
  });
});
