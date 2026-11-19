import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory } from '../../api/history';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import { chartChoicesFor, shownChartChoice, SPINDLE_SPEED, type ChartChoiceId } from './chartValues';
import MachineHistoryChart from './MachineHistoryChart';

/** The width that the fake ResizeObserver gives each chart box */
const BOX_WIDTH = 600;
/** The plot ends this far from the right edge of the box (MARGIN.right in the chart) */
const PLOT_RIGHT_MARGIN = 16;
const MINUTE = 60_000;

/** The chart with the menu state that the machine page keeps */
function ChartWithMenu({ machine, start = SPINDLE_SPEED.id }: { machine: Machine; start?: ChartChoiceId }) {
  const [chosen, setChosen] = useState<ChartChoiceId>(start);
  const choices = chartChoicesFor(machine);
  return <MachineHistoryChart machine={machine} choices={choices} choice={shownChartChoice(choices, chosen)} onChoose={setChosen} />;
}

/** A connected machine that runs program O1001 now */
function runningMachine(data: Record<string, unknown> = {}): Machine {
  return testMachine(
    { connected: true, lastPollTime: new Date().toISOString() },
    { spindleSpeed: 1200, execution: 'ACTIVE', program: 'O1001', ...data },
  );
}

vi.mock('../../api/history', () => ({ fetchValueHistory: vi.fn() }));
vi.mock('../../api/stateTimeline', () => ({ fetchStateTimeline: vi.fn() }));

describe('MachineHistoryChart', () => {
  beforeEach(() => {
    vi.mocked(fetchValueHistory).mockReset().mockResolvedValue({ points: [], window: '5s' });
    vi.mocked(fetchStateTimeline).mockReset().mockResolvedValue([]);
    // The page measures the chart box. jsdom has no ResizeObserver, so this one gives every box a size.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: BOX_WIDTH, height: 220 } } as ResizeObserverEntry], this as never); }
      disconnect() {}
    });
    // jsdom has no PointerEvent, so a hover event would have no mouse position
    vi.stubGlobal('PointerEvent', MouseEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the machine state in the menu, also when the machine sends only the spindle speed', async () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Value in the chart: Spindle speed' }));

    expect(await screen.findByRole('menuitem', { name: 'Machine state' })).toBeInTheDocument();
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

  describe('machine state view', () => {
    it('draws the band with the share of time in each state after the timeline loads', async () => {
      const now = Date.now();
      vi.mocked(fetchStateTimeline).mockResolvedValue([
        { state: 'offline', start: now - 10 * MINUTE, end: now - 5 * MINUTE },
        { state: 'running', start: now - 5 * MINUTE, end: now, program: 'O1001' },
      ]);
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);

      expect(await screen.findByRole('img', { name: /^Machine state in the last 10 minutes\. Running 50%, Idle 0%, Alarm 0%, Offline 50%/ }))
        .toBeInTheDocument();
      expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-10m');
      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
      expect(screen.getByText('Running: a program runs')).toBeInTheDocument();
    });

    it('shows the state, the program and the alarm text of the hovered segment', async () => {
      const now = Date.now();
      vi.mocked(fetchStateTimeline).mockResolvedValue([
        { state: 'alarm', start: now - 10 * MINUTE, end: now - 1 * MINUTE, detail: '1001 DOOR OPEN', program: 'O2002' },
        { state: 'running', start: now - 1 * MINUTE, end: now, program: 'O1001' },
      ]);
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);

      fireEvent.pointerMove(await screen.findByRole('img', { name: /^Machine state/ }), { clientX: BOX_WIDTH / 4 });

      expect(screen.getByText('1001 DOOR OPEN')).toBeInTheDocument();
      expect(screen.getByText('O2002')).toBeInTheDocument();
      const title = screen.getByText((_, element) => element?.tagName === 'STRONG' && /^Alarm · \d+ min/.test(element.textContent ?? ''));
      expect(title).toBeInTheDocument();
    });

    it('tells that the timeline did not load, also when a live state is known', async () => {
      vi.mocked(fetchStateTimeline).mockRejectedValue(new Error('offline'));
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);

      expect(await screen.findByText('Could not load the machine state history. Reload the page to try again.')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /^Machine state/ })).not.toBeInTheDocument();
    });
  });

  describe('value chart', () => {
    it('shows a machine state strip and its legend under the line', async () => {
      const now = Date.now();
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: now - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-10m'));
      expect(await screen.findByRole('list', { name: 'Machine state' })).toHaveTextContent('RunningIdleAlarmOffline');
    });

    it('tells that the machine state did not load, in place of the strip legend', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: Date.now() - MINUTE, value: 1000 }], window: '5s' });
      vi.mocked(fetchStateTimeline).mockRejectedValue(new Error('Chatter cannot be reached'));
      render(<ChartWithMenu machine={runningMachine()} />);

      expect(await screen.findByText('Could not load the machine state. Reload the page to try again.')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Machine state' })).not.toBeInTheDocument();
    });

    it('shows the machine state and the program at the newest point in the hover box', async () => {
      const now = Date.now();
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: now - 5 * MINUTE, value: 1000 }], window: '5s' });
      vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'running', start: now - 10 * MINUTE, end: now, program: 'O1001' }]);
      render(<ChartWithMenu machine={runningMachine()} />);

      const plot = await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalled());
      fireEvent.pointerMove(plot, { clientX: BOX_WIDTH - PLOT_RIGHT_MARGIN });

      // The hover box holds the value, the time, the state and the program
      const hoverBox = (await screen.findByText('1,200 RPM')).parentElement;
      expect(hoverBox).toHaveTextContent('Running');
      expect(hoverBox).toHaveTextContent('O1001');
    });

    it('draws the tool number as steps: the line goes straight up at a tool change', async () => {
      const now = Date.now();
      vi.mocked(fetchValueHistory).mockResolvedValue({
        // 10 s apart, so they are one line part with no gap between them
        points: [{ time: now - MINUTE, value: 3 }, { time: now - MINUTE + 10_000, value: 4 }],
        window: '5s',
      });
      render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200, toolNumber: 4 })} start="tool-number" />);

      const plot = await screen.findByRole('img', { name: /^Tool number in the last 10 minutes/ });
      const path = plot.querySelector('path.stroke-primary')?.getAttribute('d') ?? '';
      // Two points in a row at the same x: the vertical part of the step
      expect(path).toMatch(/L([\d.]+),[\d.]+L\1,/);
    });
  });
});
