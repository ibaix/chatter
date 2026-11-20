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
});
