import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRefreshWhileVisible } from './useRefreshWhileVisible';

describe('useRefreshWhileVisible', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const showPage = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('refreshes each interval while the page is visible, and not at once', () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileVisible(refresh, 20_000));

    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while the page is hidden', () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileVisible(refresh, 20_000));

    showPage('hidden');
    vi.advanceTimersByTime(60_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes at once when the page becomes visible again', () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshWhileVisible(refresh, 20_000));
    showPage('hidden');

    showPage('visible');

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('uses the newest refresh function', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ refresh }) => useRefreshWhileVisible(refresh, 20_000), { initialProps: { refresh: first } });

    rerender({ refresh: second });
    vi.advanceTimersByTime(20_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops after unmount', () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useRefreshWhileVisible(refresh, 20_000));

    unmount();
    vi.advanceTimersByTime(60_000);
    showPage('visible');

    expect(refresh).not.toHaveBeenCalled();
  });
});
