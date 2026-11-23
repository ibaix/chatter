import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onLoginCheckNeeded } from '../api/client';
import { LOGIN_IN_USE_EVERY_MS, useLoginInUse } from './useLoginInUse';

describe('useLoginInUse', () => {
  let visibility: DocumentVisibilityState = 'visible';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const showPage = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  /** The paths and methods of the requests that the hook sent */
  const sent = () => fetchMock.mock.calls.map(([input, init]) => {
    const request = input instanceof Request ? input : new Request(String(input), init as RequestInit);
    return `${request.method} ${new URL(request.url).pathname}`;
  });

  it('tells the server that the login is in use, at each interval while the page is visible', async () => {
    renderHook(() => useLoginInUse());

    await vi.advanceTimersByTimeAsync(2 * LOGIN_IN_USE_EVERY_MS);

    expect(sent()).toEqual(['POST /api/auth/sessions/in-use', 'POST /api/auth/sessions/in-use']);
  });

  it('tells nothing while the page is hidden, and tells at once when the page shows again', async () => {
    renderHook(() => useLoginInUse());
    showPage('hidden');

    await vi.advanceTimersByTimeAsync(20 * LOGIN_IN_USE_EVERY_MS);
    expect(fetchMock).not.toHaveBeenCalled();

    showPage('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(['POST /api/auth/sessions/in-use']);
  });

  it('asks for a login check when the login is gone', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Log in first' }), { status: 401 }));
    const check = vi.fn();
    const stop = onLoginCheckNeeded(check);
    renderHook(() => useLoginInUse());

    await vi.advanceTimersByTimeAsync(LOGIN_IN_USE_EVERY_MS);
    stop();

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('keeps trying when Chatter cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderHook(() => useLoginInUse());

    await vi.advanceTimersByTimeAsync(2 * LOGIN_IN_USE_EVERY_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
