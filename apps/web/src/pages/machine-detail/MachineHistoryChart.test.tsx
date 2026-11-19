import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory } from '../../api/history';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import { chartChoicesFor, shownChartChoice, SPINDLE_SPEED, type ChartChoiceId } from './chartValues';
import MachineHistoryChart from './MachineHistoryChart';

/** The chart with the menu state that the machine page keeps */
function ChartWithMenu({ machine }: { machine: Machine }) {
  const [chosen, setChosen] = useState<ChartChoiceId>(SPINDLE_SPEED.id);
  const choices = chartChoicesFor(machine);
  return <MachineHistoryChart machine={machine} choices={choices} choice={shownChartChoice(choices, chosen)} onChoose={setChosen} />;
}

vi.mock('../../api/history', () => ({ fetchValueHistory: vi.fn() }));
vi.mock('../../api/stateTimeline', () => ({ fetchStateTimeline: vi.fn() }));

describe('MachineHistoryChart', () => {
  beforeEach(() => {
    vi.mocked(fetchValueHistory).mockReset().mockResolvedValue({ points: [], window: '5s' });
    vi.mocked(fetchStateTimeline).mockReset().mockResolvedValue([]);
  });

  it('offers the machine state in the menu, also when the machine sends only the spindle speed', async () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Value in the chart: Spindle speed' }));

    expect(await screen.findByRole('menuitem', { name: 'Machine state' })).toBeInTheDocument();
  });

  it('shows the machine state as a band with the share of time in each state', async () => {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValue([
      { state: 'offline', start: now - 10 * 60_000, end: now - 5 * 60_000 },
      { state: 'running', start: now - 5 * 60_000, end: now },
    ]);
    render(<ChartWithMenu machine={testMachine({ connected: true }, { spindleSpeed: 1200, execution: 'ACTIVE' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Value in the chart: Spindle speed' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Machine state' }));

    await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-10m'));
    expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
    expect(screen.getByText('Running: a program runs')).toBeInTheDocument();
  });

  it('loads the history of the value that the user picks', async () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200, spindleLoad: 30 })} />);
    expect(fetchValueHistory).toHaveBeenCalledWith('m1', 'spindle-speed', '-10m', '5s');

    const valueButton = screen.getByRole('button', { name: 'Value in the chart: Spindle speed' });
    // The menu trigger is the button itself, not a second button around it
    expect(valueButton.parentElement?.closest('[role=button], button')).toBeNull();
    fireEvent.click(valueButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spindle load' }));

    await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledWith('m1', 'spindle-load', '-10m', '5s'));
    expect(screen.getByText('How hard the spindle worked in the last 10 minutes.')).toBeInTheDocument();
  });
});
