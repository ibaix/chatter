import { act, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from '@toolpath/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsTab } from './DiagnosticsTab';
import { RESTART_POLL_MS } from './useRestartWait';

const MINUTE = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A Chatter server whose clock is `skewMs` ahead of the browser clock (behind when negative).
 * The old process started 5 minutes ago. After the restart request, it answers one more time, then nothing, then a new process answers.
 */
function serverWithClock(skewMs: number) {
  const serverNow = () => Date.now() + skewMs;
  let process = { instance: 'old-process', startedAt: serverNow() - 5 * MINUTE };
  let answersAfterRestart = 0;
  let restarted = false;

  const health = () => {
    if (restarted) {
      answersAfterRestart++;
      if (answersAfterRestart === 2) return Promise.reject(new TypeError('Failed to fetch'));
      if (answersAfterRestart === 3) process = { instance: 'new-process', startedAt: serverNow() };
    }
    return Promise.resolve(json({ status: 'ok', uptime: (serverNow() - process.startedAt) / 1000, version: '1.2.0', instance: process.instance }));
  };

  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === '/api/health') return health();
    if (path === '/api/system/facts') {
      return Promise.resolve(json({
        version: '1.2.0', startedAt: new Date(process.startedAt).toISOString(),
        canRestartChatter: true, canRestartPi: false, isPiCard: false, network: null,
      }));
    }
    if (path === '/api/system/restart-chatter') {
      restarted = true;
      return Promise.resolve(json({ message: 'Chatter restarts' }));
    }
    if (path === '/api/logs/debug') return Promise.resolve(json({ debugUntil: null }));
    return Promise.resolve(json({ error: 'Not found' }, 404));
  }));
}

async function restartChatter() {
  render(
    <Dialog.Provider>
      <DiagnosticsTab machines={[]} />
    </Dialog.Provider>,
  );
  await screen.findByText('Chatter version');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.click(screen.getByRole('button', { name: 'Restart Chatter' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
  expect(await screen.findByText('Chatter restarts…')).toBeInTheDocument();
}

describe('DiagnosticsTab restart, with a server clock that is not the browser clock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['ahead of', 60 * MINUTE],
    ['behind', -60 * MINUTE],
  ])('sees the new process when the server clock is 1 hour %s the browser clock', async (_, skewMs) => {
    serverWithClock(skewMs);
    await restartChatter();

    // The old process answers, then nothing
    await act(() => vi.advanceTimersByTimeAsync(2 * RESTART_POLL_MS));
    expect(screen.getByText('Chatter restarts…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RESTART_POLL_MS));
    expect(screen.getByText('Chatter is back')).toBeInTheDocument();
  });
});
