import type { Role } from '@local-chatter/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMachineHealth, reconnectMachine, testMachineConnection } from '../../api/diagnostics';
import { CurrentUserContext } from '../../components/CurrentUser';
import { testMachine } from '../../test/testMachine';
import { ConnectionSection } from './ConnectionSection';

vi.mock('../../api/diagnostics', () => ({
  fetchMachineHealth: vi.fn(),
  testMachineConnection: vi.fn(),
  reconnectMachine: vi.fn(),
}));

const HEALTH = {
  offlineSince: '2026-11-21T10:00:00.000Z',
  lastError: { text: 'Poll failed: connect ECONNREFUSED 192.168.1.50:10000', time: '2026-11-21T10:00:00.000Z' },
  events: [
    { time: '2026-11-21T10:00:00.000Z', tone: 'bad' as const, text: 'Machine went offline: Poll failed: connect ECONNREFUSED' },
    { time: '2026-11-21T09:00:00.000Z', tone: 'good' as const, text: 'Machine connected' },
  ],
  lastPollTime: null,
  serverTime: '2026-11-21T10:05:00.000Z',
};

function renderSection(role: Role = 'admin') {
  render(
    <CurrentUserContext.Provider value={{ username: role, role }}>
      <ConnectionSection machine={testMachine({ connected: false })} />
    </CurrentUserContext.Provider>,
  );
}

describe('ConnectionSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchMachineHealth).mockResolvedValue(HEALTH);
  });

  it('shows the last error and the last connection changes to each user, with no buttons for a viewer', async () => {
    renderSection('viewer');

    expect(await screen.findByText(/Poll failed: connect ECONNREFUSED 192\.168\.1\.50:10000/)).toBeInTheDocument();
    const events = screen.getByRole('region', { name: 'Last connection changes' });
    expect(within(events).getByText('Machine connected')).toBeInTheDocument();
    expect(screen.getByText('Offline since')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  });

  it('tests the connection, and shows each step with its result and hint', async () => {
    vi.mocked(testMachineConnection).mockResolvedValue({
      host: '192.168.1.50',
      testedAt: '2026-11-21T10:05:00.000Z',
      steps: [
        { name: 'Address', result: 'ok', text: '192.168.1.50 is an IP address, so no DNS lookup is necessary.' },
        { name: 'Port 10000 (data)', result: 'ok', text: 'The port is open.' },
        { name: 'Answer', result: 'failed', text: 'Connected to port 10000, but no correct reply came in 3 s.', hint: 'Another program may be connected.' },
      ],
    });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    const result = await screen.findByRole('region', { name: 'Connection test result' });
    expect(within(result).getByText('Port 10000 (data)')).toBeInTheDocument();
    expect(within(result).getByText('Failed')).toBeInTheDocument();
    expect(within(result).getByText('Another program may be connected.')).toBeInTheDocument();
    expect(testMachineConnection).toHaveBeenCalledWith('m1');
    expect(screen.getByText(/It does not use ping/)).toBeInTheDocument();
  });

  it('reconnects, and shows the reason when a poll has not ended', async () => {
    vi.mocked(reconnectMachine).mockRejectedValue(new Error('A poll of this machine has not ended, so Chatter does not start a second poll.'));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    expect(await screen.findByText('A poll of this machine has not ended, so Chatter does not start a second poll.')).toBeInTheDocument();
    expect(fetchMachineHealth).toHaveBeenCalledTimes(2);
  });
});
