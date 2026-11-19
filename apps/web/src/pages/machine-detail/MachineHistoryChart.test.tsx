import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory } from '../../api/history';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import { chartValuesFor, shownChartValue, SPINDLE_SPEED } from './chartValues';
import MachineHistoryChart from './MachineHistoryChart';

/** The chart with the menu state that the machine page keeps */
function ChartWithMenu({ machine }: { machine: Machine }) {
  const [chosen, setChosen] = useState(SPINDLE_SPEED.id);
  const values = chartValuesFor(machine);
  return <MachineHistoryChart machine={machine} values={values} value={shownChartValue(values, chosen)} onChoose={setChosen} />;
}

vi.mock('../../api/history', () => ({ fetchValueHistory: vi.fn() }));

describe('MachineHistoryChart', () => {
  beforeEach(() => {
    vi.mocked(fetchValueHistory).mockReset().mockResolvedValue({ points: [], window: '5s' });
    // The page measures the chart box. jsdom has no ResizeObserver, so this one gives every box a size.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 600, height: 220 } } as ResizeObserverEntry], this as never); }
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells that the history did not load, also when it has a live value', async () => {
    vi.mocked(fetchValueHistory).mockRejectedValue(new Error('Chatter cannot be reached'));
    const lastPoll = new Date(Date.now() - 17 * 60_000).toISOString();
    render(<ChartWithMenu machine={testMachine({ connected: true, lastPollTime: lastPoll }, { spindleSpeed: 1200 })} />);
    // At 1 hour the 17-minute-old live value is in the range, so the chart has a point
    fireEvent.click(screen.getByRole('button', { name: '1h' }));

    expect(await screen.findByText('Could not load the spindle speed history. Reload the page to try again.')).toBeInTheDocument();
  });

  it('shows the saved history of a machine that is not connected now', async () => {
    const start = Date.now() - 40 * 60_000;
    const points = Array.from({ length: 30 }, (_, index) => ({ time: start + index * 5000, value: 2000 }));
    vi.mocked(fetchValueHistory).mockResolvedValue({ points, window: '5s' });
    render(<ChartWithMenu machine={testMachine({ connected: false }, { spindleSpeed: 2000 })} />);
    fireEvent.click(screen.getByRole('button', { name: '1h' }));

    const plot = await screen.findByRole('img', { name: /^Spindle speed in the last hour/ });
    expect(plot.querySelector('path.stroke-primary')?.getAttribute('d')?.split('L')).toHaveLength(30);
  });

  it('draws a value that has no neighbors as a dot, because a line needs two points', async () => {
    vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: Date.now() - 5 * 60_000, value: 1200 }], window: '5s' });
    render(<ChartWithMenu machine={testMachine({ connected: false }, { spindleSpeed: 1200 })} />);

    const plot = await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });
    expect(plot.querySelectorAll('circle.fill-primary')).toHaveLength(1);
  });

  it('takes no live value from a machine that is connecting, because its values are old', async () => {
    vi.mocked(fetchValueHistory).mockReturnValue(new Promise(() => {}));
    const now = new Date().toISOString();
    render(<ChartWithMenu machine={testMachine({ connected: true, connecting: true, lastPollTime: now }, { spindleSpeed: 1200 })} />);

    expect(await screen.findByText('Loading the spindle speed history…')).toBeInTheDocument();
  });

  it('shows the spindle speed as a plain title when the machine sends no other value', () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200 })} />);

    expect(screen.queryByRole('button', { name: /Value in the chart/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Spindle speed/ })).toBeInTheDocument();
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
