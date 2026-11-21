import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { MachineTable } from './MachineTable';

describe('MachineTable', () => {
  it('shows a machine that is connecting as Connecting, with no values and no error from a try that failed', () => {
    const machine = testMachine(
      { name: 'Speedio', connected: false, connecting: true, errors: ['Connection timeout'] },
      { program: 'O1234', spindleSpeed: 8000 },
    );
    render(<MemoryRouter><MachineTable machines={[machine]} now={Date.now()} /></MemoryRouter>);

    const row = screen.getByRole('row', { name: /Speedio/ });
    expect(within(row).getByText('Connecting')).toBeInTheDocument();
    expect(within(row).queryByText('O1234')).not.toBeInTheDocument();
    expect(within(row).queryByText('8,000')).not.toBeInTheDocument();
    expect(within(row).queryByText('Connection timeout')).not.toBeInTheDocument();
  });

  it('shows "Not polled for N min" when the last poll result is too old, for example a poll that never ended', () => {
    const now = Date.parse('2026-11-21T10:20:00Z');
    const stuck = testMachine({
      name: 'Speedio',
      pollClock: { lastEndedAt: '2026-11-21T10:08:00Z', overdueAfterMs: 60_000, inProgressSince: '2026-11-21T10:08:02Z' },
    });
    const fine = testMachine({
      id: 'm2', name: 'Haas', pollClock: { lastEndedAt: '2026-11-21T10:19:58Z', overdueAfterMs: 60_000, inProgressSince: null },
    });
    render(<MemoryRouter><MachineTable machines={[stuck, fine]} now={now} /></MemoryRouter>);

    expect(within(screen.getByRole('row', { name: /Speedio/ })).getByText('Not polled for 12 min')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Haas/ })).queryByText(/Not polled/)).not.toBeInTheDocument();
  });
});
