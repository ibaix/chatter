import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory, type HistoryPoint } from '../../api/history';
import { CHART_RANGES, type ChartRange } from './historyChart';
import { useChartHistory } from './useChartHistory';

vi.mock('../../api/history', () => ({ fetchValueHistory: vi.fn() }));

const [TEN_MINUTES] = CHART_RANGES;
const MINUTE = 60_000;

/** A load that never ends, so the test can see the chart while it loads */
function waitingLoad() {
  return new Promise<never>(() => {});
}

interface Props {
  machineId: string;
  value: 'spindle-speed' | 'spindle-load';
  live: HistoryPoint | null;
  range: ChartRange;
  end: number | null;
}

function renderChartHistory(initialProps: Partial<Props> = {}) {
  // The chart clock is the page clock here
  return renderHook((props: Props) => useChartHistory(props.machineId, props.value, props.live, props.range, props.end, Date.now()), {
    initialProps: { machineId: 'm1', value: 'spindle-speed', live: null, range: TEN_MINUTES, end: null, ...initialProps },
  });
}

describe('useChartHistory', () => {
  beforeEach(() => {
    vi.mocked(fetchValueHistory).mockReset();
  });

  it('sends one request in StrictMode, which runs each effect twice in development', async () => {
    vi.mocked(fetchValueHistory).mockResolvedValue({ points: [], window: '5s' });
    const { result } = renderHook(() => useChartHistory('m1', 'spindle-speed', null, TEN_MINUTES, null, Date.now()), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchValueHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps the old points of the same value while another time loads', async () => {
    const now = Date.now();
    vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: now - 2 * MINUTE, value: 800 }], window: '5s' });
    const { result, rerender } = renderChartHistory();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(fetchValueHistory).mockReturnValue(waitingLoad());
    rerender({ machineId: 'm1', value: 'spindle-speed', live: null, range: TEN_MINUTES, end: now - 5 * MINUTE });

    expect(result.current.status).toBe('loading');
    expect(result.current.points).toEqual([{ time: now - 2 * MINUTE, value: 800 }]);
  });

  it('does not show the points of another value or another machine', async () => {
    const now = Date.now();
    vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: now - MINUTE, value: 800 }], window: '5s' });
    const { result, rerender } = renderChartHistory();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(fetchValueHistory).mockReturnValue(waitingLoad());
    rerender({ machineId: 'm1', value: 'spindle-load', live: null, range: TEN_MINUTES, end: null });
    expect(result.current.points).toEqual([]);

    rerender({ machineId: 'm2', value: 'spindle-load', live: null, range: TEN_MINUTES, end: null });
    expect(result.current.points).toEqual([]);
  });

  it('shows no live values in a chart that looks back in time', async () => {
    const end = Date.now() - 30 * MINUTE;
    vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: end - MINUTE, value: 800 }], window: '5s' });
    const { result, rerender } = renderChartHistory({ end });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ machineId: 'm1', value: 'spindle-speed', live: { time: Date.now(), value: 1500 }, range: TEN_MINUTES, end });

    expect(result.current.points).toEqual([{ time: end - MINUTE, value: 800 }]);
    expect(result.current.now).toBe(end);
  });

  it('adds the live values again when the chart goes back to now', async () => {
    const now = Date.now();
    vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: now - 40 * MINUTE, value: 800 }], window: '5s' });
    const live = { time: now, value: 1500 };
    const { result, rerender } = renderChartHistory({ end: now - 30 * MINUTE, live });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: now - MINUTE, value: 1200 }], window: '5s' });
    rerender({ machineId: 'm1', value: 'spindle-speed', live, range: TEN_MINUTES, end: null });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ machineId: 'm1', value: 'spindle-speed', live: { time: now + 10_000, value: 1600 }, range: TEN_MINUTES, end: null });

    expect(result.current.points).toEqual([
      { time: now - MINUTE, value: 1200 },
      { time: now, value: 1500 },
      { time: now + 10_000, value: 1600 },
    ]);
  });

  it('tells that the load failed after a move in time, and keeps the old points', async () => {
    const now = Date.now();
    vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: now - MINUTE, value: 800 }], window: '5s' });
    const { result, rerender } = renderChartHistory();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(fetchValueHistory).mockRejectedValueOnce(new Error('Chatter cannot be reached'));
    rerender({ machineId: 'm1', value: 'spindle-speed', live: null, range: TEN_MINUTES, end: now - 5 * MINUTE });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.points).toEqual([{ time: now - MINUTE, value: 800 }]);
  });
});
