import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { CHART_RANGES } from './historyChart';
import type { LiveState } from './stateTimeline';
import { useStateTimeline } from './useStateTimeline';

vi.mock('../../api/stateTimeline', () => ({ fetchStateTimeline: vi.fn() }));

const [TEN_MINUTES, ONE_HOUR] = CHART_RANGES;
const MINUTE = 60_000;

/** A load that ends only when the test says so */
function waitingLoad() {
  return new Promise<never>(() => {});
}

interface Props {
  machineId: string;
  live: LiveState | undefined;
  range: typeof TEN_MINUTES;
}

describe('useStateTimeline', () => {
  beforeEach(() => {
    vi.mocked(fetchStateTimeline).mockReset();
  });

  it('gives the loaded segments, and the live state from the time it changes', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'idle', start: now - 5 * MINUTE, end: now }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'idle', time: Date.now() }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ machineId: 'm1', live: { state: 'running', program: 'O1', time: Date.now() }, range: TEN_MINUTES });

    expect(result.current.segments.map(segment => segment.state)).toEqual(['idle', 'running']);
    expect(result.current.segments[1].program).toBe('O1');
  });

  it('keeps the old segments while a new range loads, and loads one more range before the chart', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValueOnce([{ state: 'alarm', start: now - 5 * MINUTE, end: now - 4 * MINUTE }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'idle', time: Date.now() }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(fetchStateTimeline).mockReturnValueOnce(waitingLoad());

    rerender({ machineId: 'm1', live: { state: 'idle', time: Date.now() }, range: ONE_HOUR });

    expect(result.current.status).toBe('loading');
    expect(result.current.segments.map(segment => segment.state)).toEqual(['alarm', 'idle']);
    expect(fetchStateTimeline).toHaveBeenNthCalledWith(1, 'm1', '-20m', undefined);
    expect(fetchStateTimeline).toHaveBeenLastCalledWith('m1', '-2h', undefined);
  });

  it('does not show the segments of the last machine for a new machine', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValueOnce([{ state: 'alarm', start: now - 5 * MINUTE, end: now }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'alarm', time: Date.now() }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(fetchStateTimeline).mockRejectedValueOnce(new Error('offline'));

    rerender({ machineId: 'm2', live: { state: 'running', time: Date.now() }, range: TEN_MINUTES });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.segments.map(segment => segment.state)).toEqual(['running']);
  });

  it('adds a live change that comes while the timeline loads', async () => {
    const now = Date.now();
    let finishLoad: (segments: Awaited<ReturnType<typeof fetchStateTimeline>>) => void = () => {};
    vi.mocked(fetchStateTimeline).mockReturnValue(new Promise(resolve => { finishLoad = resolve; }));
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'idle', time: Date.now() }, range: TEN_MINUTES },
    });

    rerender({ machineId: 'm1', live: { state: 'running', time: Date.now() }, range: TEN_MINUTES });
    finishLoad([{ state: 'idle', start: now - 5 * MINUTE, end: now - MINUTE }]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.segments.at(-1)?.state).toBe('running');
  });

  it('shows no old segments on the first render for a new machine', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValueOnce([{ state: 'alarm', start: now - 5 * MINUTE, end: now }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: undefined, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(fetchStateTimeline).mockReturnValueOnce(waitingLoad());
    const seen: string[][] = [];

    rerender({ machineId: 'm2', live: undefined, range: TEN_MINUTES });
    seen.push(result.current.segments.map(segment => segment.state));

    expect(seen).toEqual([[]]);
    expect(result.current.status).toBe('loading');
  });

  it('stops the band where the live state was last known, and does not paint the old state up to now', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const start = Date.now();
      vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'running', start: start - 5 * MINUTE, end: start }]);
      const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
        initialProps: { machineId: 'm1', live: { state: 'running', time: start }, range: TEN_MINUTES },
      });
      await vi.waitFor(() => expect(result.current.status).toBe('ready'));

      rerender({ machineId: 'm1', live: undefined, range: TEN_MINUTES });
      await vi.advanceTimersByTimeAsync(MINUTE);

      const last = result.current.segments.at(-1)!;
      expect(last.state).toBe('running');
      expect(last.end).toBeLessThan(result.current.now - 30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the band at the chart clock when the chart gives one, so the strip ends where the line ends', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'running', start: now - 5 * MINUTE, end: now - MINUTE }]);
    const chartNow = now + 2000;
    const { result } = renderHook(() => useStateTimeline('m1', { state: 'running', time: now - MINUTE }, TEN_MINUTES, chartNow));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.segments.at(-1)?.end).toBe(chartNow);
  });

  it('sends one request when two charts ask for the same timeline at the same time', async () => {
    vi.mocked(fetchStateTimeline).mockResolvedValue([]);
    const { result } = renderHook(() => [
      useStateTimeline('m1', undefined, TEN_MINUTES),
      useStateTimeline('m1', undefined, TEN_MINUTES),
      useStateTimeline('m1', undefined, ONE_HOUR),
    ]);

    await waitFor(() => expect(result.current.every(timeline => timeline.status === 'ready')).toBe(true));
    expect(fetchStateTimeline).toHaveBeenCalledTimes(2);
  });

  it('keeps sharing a request when an older request for the same timeline ends', async () => {
    let endOldRequest = () => {};
    vi.mocked(fetchStateTimeline).mockReturnValueOnce(new Promise(resolve => { endOldRequest = () => resolve([]); }));
    const first = renderHook(() => useStateTimeline('m1', undefined, TEN_MINUTES));
    first.unmount();
    vi.mocked(fetchStateTimeline).mockReturnValueOnce(waitingLoad());
    renderHook(() => useStateTimeline('m1', undefined, TEN_MINUTES));

    endOldRequest();
    await Promise.resolve();
    renderHook(() => useStateTimeline('m1', undefined, TEN_MINUTES));

    expect(fetchStateTimeline).toHaveBeenCalledTimes(2);
  });

  it('gives the segments after the end of a chart in the past, so a drag on shows them at once', async () => {
    const end = Date.now() - 60 * MINUTE;
    vi.mocked(fetchStateTimeline).mockResolvedValue([
      { state: 'running', start: end - 30 * MINUTE, end: end - 5 * MINUTE },
      { state: 'alarm', start: end - 5 * MINUTE, end: end + 10 * MINUTE },
    ]);
    const { result } = renderHook(() => useStateTimeline('m1', { state: 'idle', time: Date.now() }, TEN_MINUTES, undefined, end));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-30m', end + 10 * MINUTE);
    expect(result.current.now).toBe(end);
    expect(result.current.segments.at(-1)).toMatchObject({ state: 'alarm', end: end + 10 * MINUTE });
  });
});
