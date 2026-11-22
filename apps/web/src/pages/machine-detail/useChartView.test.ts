import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChartView } from './useChartView';

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
});
