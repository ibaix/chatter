import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Dialog } from '@toolpath/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDebugState, fetchHelperLog, fetchInstance, fetchSystemFacts, restartChatter, restartPi, setDebug, type SystemFacts,
} from '../../api/diagnostics';
import { DiagnosticsTab } from './DiagnosticsTab';
import { LIVE_LINES } from './LogPanel';
import { RESTART_LATE_MS, RESTART_POLL_MS } from './useRestartWait';

vi.mock('../../api/diagnostics', () => ({
  fetchSystemFacts: vi.fn(),
  restartChatter: vi.fn(),
  restartPi: vi.fn(),
  fetchInstance: vi.fn(),
  fetchDebugState: vi.fn(),
  setDebug: vi.fn(),
  fetchHelperLog: vi.fn(),
  logDownloadUrl: (filter: { level?: string; machine?: string }) => `/api/logs?${new URLSearchParams(filter as Record<string, string>)}`,
  logStreamUrl: (filter: { level?: string; machine?: string }) => `/api/logs/stream?${new URLSearchParams(filter as Record<string, string>)}`,
  supportBundleUrl: () => '/api/support-bundle',
}));

// jsdom has no PointerEvent, and the Switch of the Toolpath UI package makes one on a click
globalThis.PointerEvent ??= MouseEvent as typeof PointerEvent;

/** A stand-in for the browser's EventSource. The test sends the events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(type: string, data = '') {
    act(() => this.listeners.get(type)?.forEach(listener => listener(new MessageEvent(type, { data }))));
  }

  close() {
    this.closed = true;
  }
}

const STARTED_AT = '2026-11-21T08:00:00.000Z';

function facts(changes: Partial<SystemFacts> = {}): SystemFacts {
  return {
    version: '1.2.0', startedAt: STARTED_AT, canRestartChatter: true, canRestartPi: false, isPiCard: false, network: null, ...changes,
  };
}

async function renderTab(loaded: SystemFacts) {
  vi.mocked(fetchSystemFacts).mockResolvedValue(loaded);
  render(
    <Dialog.Provider>
      <DiagnosticsTab machines={[{ id: 'm1', name: 'Speedio' }]} />
    </Dialog.Provider>,
  );
  await screen.findByText('Chatter version');
}

describe('DiagnosticsTab', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchDebugState).mockResolvedValue({ debugUntil: null });
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the network facts of the Pi, and the address of this page', async () => {
    await renderTab(facts({
      isPiCard: true,
      canRestartPi: true,
      network: {
        hostname: 'chatter', localName: 'chatter.local', addresses: [{ interface: 'eth0', address: '192.168.1.20/24' }],
        gateway: '192.168.1.1', ssh: false, updatedAt: '2026-11-21T10:00:00Z',
      },
    }));

    const panel = screen.getByRole('region', { name: 'This computer' });
    expect(within(panel).getByText('chatter.local')).toBeInTheDocument();
    expect(within(panel).getByText('192.168.1.20/24')).toBeInTheDocument();
    expect(within(panel).getByText('Address (eth0)')).toBeInTheDocument();
    expect(within(panel).getByText('Off')).toBeInTheDocument();
    expect(within(panel).getByText(window.location.host)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart the Pi' })).toBeInTheDocument();
  });

  it('says that a new card image is necessary for the facts and the Pi restart, with an older helper', async () => {
    await renderTab(facts({ isPiCard: true }));

    expect(screen.getByText('A new card image shows more facts here')).toBeInTheDocument();
    expect(screen.getByText('To restart the Pi from this page, a new card image is necessary.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart the Pi' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Update helper log' })).toBeInTheDocument();
  });

  it('restarts Chatter after a confirm, and says when it is back', async () => {
    await renderTab(facts());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(restartChatter).mockResolvedValue();
    // First the old process answers, then nothing, then the new process
    // Before the request, the old process answers. Then it answers once more, then nothing, then the new process.
    vi.mocked(fetchInstance)
      .mockResolvedValueOnce('old-process')
      .mockResolvedValueOnce('old-process')
      .mockResolvedValueOnce(null)
      .mockResolvedValue('new-process');

    fireEvent.click(screen.getByRole('button', { name: 'Restart Chatter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));

    expect(await screen.findByText('Chatter restarts…')).toBeInTheDocument();
    expect(restartChatter).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2 * RESTART_POLL_MS));
    expect(screen.getByText('Chatter restarts…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RESTART_POLL_MS));
    expect(screen.getByText('Chatter is back')).toBeInTheDocument();
  });

  it('when the old process did not answer before the request, waits for a time with no answer before it says "back"', async () => {
    await renderTab(facts());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(restartChatter).mockResolvedValue();
    vi.mocked(fetchInstance)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('old-process')
      .mockResolvedValueOnce(null)
      .mockResolvedValue('new-process');

    fireEvent.click(screen.getByRole('button', { name: 'Restart Chatter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));

    expect(await screen.findByText('Chatter restarts…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2 * RESTART_POLL_MS));
    expect(screen.getByText('Chatter restarts…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RESTART_POLL_MS));
    expect(screen.getByText('Chatter is back')).toBeInTheDocument();
  });

  it('says what to check when Chatter does not come back in 5 minutes', async () => {
    await renderTab(facts());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(restartChatter).mockResolvedValue();
    vi.mocked(fetchInstance).mockResolvedValue(null);

    fireEvent.click(screen.getByRole('button', { name: 'Restart Chatter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await screen.findByText('Chatter restarts…');
    await act(() => vi.advanceTimersByTimeAsync(RESTART_LATE_MS + RESTART_POLL_MS));

    expect(screen.getByText('Chatter did not come back in 5 minutes')).toBeInTheDocument();
  });

  it('does not restart when the admin says "Not now", and has no restart outside Docker', async () => {
    await renderTab(facts());
    fireEvent.click(screen.getByRole('button', { name: 'Restart Chatter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(restartChatter).not.toHaveBeenCalled();
    expect(restartPi).not.toHaveBeenCalled();
  });

  it('has no Chatter restart outside Docker', async () => {
    await renderTab(facts({ canRestartChatter: false }));
    expect(screen.queryByRole('button', { name: 'Restart Chatter' })).not.toBeInTheDocument();
    expect(screen.getByText(/does not run in Docker here/)).toBeInTheDocument();
  });

  it('links the log download to the chosen level and machine, and links the support bundle', async () => {
    await renderTab(facts());

    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'warn' } });
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'm1' } });

    expect(screen.getByRole('link', { name: 'Download the log' })).toHaveAttribute('href', '/api/logs?level=warn&machine=m1');
    expect(screen.getByRole('link', { name: 'Download the support bundle' })).toHaveAttribute('href', '/api/support-bundle');
  });

  it('tells that the support bundle hides the saved secrets only, so the log in it can have addresses or phone numbers', async () => {
    await renderTab(facts());

    expect(screen.getByText(/does not have the passwords and tokens that are saved in the settings/)).toBeInTheDocument();
    expect(screen.getByText(/the log can contain addresses or phone numbers/)).toBeInTheDocument();
  });

  it('turns on the debug level, and tells when it turns off', async () => {
    vi.mocked(setDebug).mockResolvedValue({ debugUntil: '2026-11-21T10:15:00.000Z' });
    await renderTab(facts());

    // The switch is off until the debug state loads, and a click on it then does nothing
    const debugSwitch = await screen.findByRole('switch');
    await waitFor(() => expect(debugSwitch).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(debugSwitch);

    expect(setDebug).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/^On until .*\. Then it turns off by itself\.$/)).toBeInTheDocument();
  });

  it('shows the live log, the dropped lines, and at most the last lines', async () => {
    await renderTab(facts());
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the live log' }));

    const source = FakeEventSource.last!;
    expect(source.url).toBe('/api/logs/stream?machine=m1');
    source.send('line', 'first line');
    source.send('dropped', '12');
    expect(screen.getByLabelText('Live log')).toHaveTextContent('first line [12 lines dropped: the browser was too slow]');

    for (let index = 0; index < LIVE_LINES + 5; index++) source.send('line', `line ${index}`);
    expect(screen.getByLabelText('Live log').textContent!.split('\n')).toHaveLength(LIVE_LINES);

    source.send('error');
    expect(screen.getByText('The live log is not connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the live log' }));
    expect(source.closed).toBe(true);
  });

  it('shows the helper log, or says that the Pi needs a new card image for it', async () => {
    vi.mocked(fetchHelperLog).mockResolvedValueOnce('2026-11-21T10:00:00Z [request] Step: copying.\n').mockResolvedValueOnce(null);
    await renderTab(facts({ isPiCard: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Show the log' }));
    expect(await screen.findByLabelText('Update helper log')).toHaveTextContent('[request] Step: copying.');
    fireEvent.click(screen.getByRole('button', { name: 'Load again' }));
    expect(await screen.findByText('This Pi has no helper log yet')).toBeInTheDocument();
  });
});
