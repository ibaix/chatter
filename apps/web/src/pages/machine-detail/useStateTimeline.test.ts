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
      initialProps: { machineId: 'm1', live: { state: 'idle' }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ machineId: 'm1', live: { state: 'running', program: 'O1' }, range: TEN_MINUTES });

    expect(result.current.segments.map(segment => segment.state)).toEqual(['idle', 'running']);
    expect(result.current.segments[1].program).toBe('O1');
  });

  it('drops the old segments while a new range loads', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValueOnce([{ state: 'alarm', start: now - 5 * MINUTE, end: now - 4 * MINUTE }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'idle' }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(fetchStateTimeline).mockReturnValueOnce(waitingLoad());

    rerender({ machineId: 'm1', live: { state: 'idle' }, range: ONE_HOUR });

    expect(result.current.status).toBe('loading');
    expect(result.current.segments.map(segment => segment.state)).toEqual(['idle']);
  });

  it('does not show the segments of the last machine for a new machine', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValueOnce([{ state: 'alarm', start: now - 5 * MINUTE, end: now }]);
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'alarm' }, range: TEN_MINUTES },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(fetchStateTimeline).mockRejectedValueOnce(new Error('offline'));

    rerender({ machineId: 'm2', live: { state: 'running' }, range: TEN_MINUTES });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.segments.map(segment => segment.state)).toEqual(['running']);
  });

  it('adds a live change that comes while the timeline loads', async () => {
    const now = Date.now();
    let finishLoad: (segments: Awaited<ReturnType<typeof fetchStateTimeline>>) => void = () => {};
    vi.mocked(fetchStateTimeline).mockReturnValue(new Promise(resolve => { finishLoad = resolve; }));
    const { result, rerender } = renderHook((props: Props) => useStateTimeline(props.machineId, props.live, props.range), {
      initialProps: { machineId: 'm1', live: { state: 'idle' }, range: TEN_MINUTES },
    });

    rerender({ machineId: 'm1', live: { state: 'running' }, range: TEN_MINUTES });
    finishLoad([{ state: 'idle', start: now - 5 * MINUTE, end: now - MINUTE }]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.segments.at(-1)?.state).toBe('running');
  });
});
