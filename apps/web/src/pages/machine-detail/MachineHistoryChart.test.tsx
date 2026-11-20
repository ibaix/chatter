import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory } from '../../api/history';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import { durationMs } from './historyChart';
import { chartChoicesFor, shownChartChoice, SPINDLE_SPEED, type ChartChoiceId } from './chartValues';
import MachineHistoryChart from './MachineHistoryChart';

/** The width that the fake ResizeObserver gives each chart box */
const BOX_WIDTH = 600;
/** The plot ends this far from the right edge of the box (MARGIN.right in the chart) */
const PLOT_RIGHT_MARGIN = 16;
const MINUTE = 60_000;

/**
 * The end of the time that a chart shows, from its request. The chart loads one more range before it, and one more
 * after it up to now (loadSpan). A request with no end ends now.
 */
function viewEndOf(call: unknown[], rangeMs: number): number {
  const [, query, end] = call.length > 3 ? [call[0], call[2], call[4]] : call;
  const loadedMs = durationMs(query as string);
  return end === undefined ? Date.now() - (loadedMs - 2 * rangeMs) : (end as number) - rangeMs;
}

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
    expect(fetchValueHistory).toHaveBeenCalledWith('m1', 'spindle-speed', '-20m', '5s');

    const valueButton = screen.getByRole('button', { name: 'Value in the chart: Spindle speed' });
    // The menu trigger is the button itself, not a second button around it
    expect(valueButton.parentElement?.closest('[role=button], button')).toBeNull();
    fireEvent.click(valueButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spindle load' }));

    await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledWith('m1', 'spindle-load', '-20m', '5s'));
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
      expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-20m');
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

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledWith('m1', '-20m'));
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

    it('tells that a new time did not load, also when it has points of the last time', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: Date.now() - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });

      vi.mocked(fetchValueHistory).mockRejectedValueOnce(new Error('Chatter cannot be reached'));
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

      expect(await screen.findByText('Could not load the spindle speed history. Reload the page to try again.')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /^Spindle speed/ })).not.toBeInTheDocument();
    });

    it('shows a loading mark over the old line while a new time loads', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValueOnce({ points: [{ time: Date.now() - 8 * MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      vi.mocked(fetchValueHistory).mockReturnValue(new Promise(() => {}));
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Loading');
      expect(screen.getByRole('img', { name: /^Spindle speed from / })).toBeInTheDocument();
    });

    it('tells that the shown time has no data, when the data is only in the time around it', async () => {
      // The chart loads 10 more minutes before the 10 minutes that show
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: Date.now() - 15 * MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200 })} />);

      expect(await screen.findByText('No spindle speed in the last 10 minutes. Chatter saves it while the machine is connected.')).toBeInTheDocument();
    });

    it('tells the newest value in the shown time, not in the time after it', async () => {
      const now = Date.now();
      // After Earlier, the chart shows the 10 minutes that end 5 minutes ago, and loads the 5 minutes after them
      vi.mocked(fetchValueHistory).mockResolvedValue({
        points: [{ time: now - 7 * MINUTE, value: 1000 }, { time: now - 2 * MINUTE, value: 2000 }],
        window: '5s',
      });
      render(<ChartWithMenu machine={runningMachine()} />);
      await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });

      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

      expect(await screen.findByRole('img', { name: /^Spindle speed from .*Newest value: 1,000 RPM\.$/ })).toBeInTheDocument();
    });
  });

  /** The part of the chart that moves in time with a drag */
  function chartBody() {
    const body = screen.getByRole('group', { name: 'Chart: drag or scroll sideways to move in time' });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 0, width: BOX_WIDTH } as DOMRect);
    return body;
  }

  function drag(target: Element, fromX: number, toX: number) {
    fireEvent.pointerDown(target, { button: 0, clientX: fromX, pointerId: 1 });
    fireEvent.pointerMove(target, { clientX: toX, pointerId: 1 });
    fireEvent.pointerUp(target, { clientX: toX, pointerId: 1 });
  }

  /** The machine state view, and its overview strip. The strip goes from 0 to BOX_WIDTH. */
  async function overviewOfStateView() {
    const now = Date.now();
    vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'running', start: now - 10 * MINUTE, end: now }]);
    render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
    return screen.findByRole('img', { name: /^Overview of the last 10 minutes/ });
  }

  describe('moving in time', () => {
    it('goes back half a range with Earlier, and back to the live chart with Now', async () => {
      render(<ChartWithMenu machine={runningMachine()} />);
      expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();

      const before = Date.now();
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

      await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledTimes(2));
      for (const call of [vi.mocked(fetchValueHistory).mock.lastCall!, vi.mocked(fetchStateTimeline).mock.lastCall!]) {
        const end = viewEndOf(call, 10 * MINUTE);
        expect(end).toBeGreaterThanOrEqual(before - 5 * MINUTE - 1000);
        expect(end).toBeLessThanOrEqual(Date.now() - 5 * MINUTE + 1000);
      }
      expect(screen.getByText(/^How fast the spindle turned from /)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Later' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Now' }));

      await waitFor(() => expect(fetchValueHistory).toHaveBeenLastCalledWith('m1', 'spindle-speed', '-20m', '5s'));
      expect(screen.getByText('How fast the spindle turned in the last 10 minutes.')).toBeInTheDocument();
    });

    it('moves the time with a sideways scroll, but not with an up or down scroll', async () => {
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(1));

      fireEvent.wheel(chartBody(), { deltaX: 0, deltaY: 200 });
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);

      fireEvent.wheel(chartBody(), { deltaX: -80, deltaY: 0 });
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      expect(viewEndOf(vi.mocked(fetchStateTimeline).mock.lastCall!, 10 * MINUTE)).toBeLessThan(Date.now() - 2 * MINUTE);
    });

    it('moves the time when the user drags the chart: to the right goes back', async () => {
      await overviewOfStateView();
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);

      const before = Date.now();
      drag(chartBody(), 100, 100 + BOX_WIDTH / 2);

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      const end = viewEndOf(vi.mocked(fetchStateTimeline).mock.lastCall!, 10 * MINUTE);
      expect(end).toBeGreaterThanOrEqual(before - 5 * MINUTE - 1000);
      expect(end).toBeLessThanOrEqual(Date.now() - 5 * MINUTE + 1000);
    });

    it('shows the time before the chart while the user drags, and keeps it while the new time loads', async () => {
      const now = Date.now();
      // The chart loads 20 minutes: the alarm is before the 10 minutes that show
      vi.mocked(fetchStateTimeline).mockResolvedValue([
        { state: 'alarm', start: now - 20 * MINUTE, end: now - 10 * MINUTE },
        { state: 'running', start: now - 10 * MINUTE, end: now },
      ]);
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
      expect(await screen.findByRole('img', { name: /Running 100%, Idle 0%, Alarm 0%/ })).toBeInTheDocument();

      fireEvent.pointerDown(chartBody(), { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(chartBody(), { clientX: 100 + BOX_WIDTH / 2, pointerId: 1 });

      expect(screen.getByRole('img', { name: /^Machine state from .* Running 50%, Idle 0%, Alarm 50%/ })).toBeInTheDocument();
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);

      vi.mocked(fetchStateTimeline).mockReturnValue(new Promise(() => {}));
      fireEvent.pointerUp(chartBody(), { clientX: 100 + BOX_WIDTH / 2, pointerId: 1 });

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('img', { name: /^Machine state from .* Alarm 50%/ })).toBeInTheDocument();
    });

    it('does not move the time for a click, or for a drag of the live chart into the future', async () => {
      await overviewOfStateView();

      drag(chartBody(), 300, 302);
      drag(chartBody(), 300, 100);

      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
    });

    it('goes back to the live chart when the user picks another range', async () => {
      render(<ChartWithMenu machine={runningMachine()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Now' })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: '1h' }));

      await waitFor(() => expect(fetchValueHistory).toHaveBeenLastCalledWith('m1', 'spindle-speed', '-2h', '10s'));
      expect(screen.getByRole('button', { name: 'Now' })).toBeDisabled();
    });
  });

  describe('zooming in on the overview strip', () => {
    it('shows the time that the user highlights on the strip', async () => {
      const now = Date.now();
      const overview = await overviewOfStateView();

      // From 1/4 to 3/4 of the 10-minute strip: 5 minutes that end 2.5 minutes ago
      drag(overview, BOX_WIDTH / 4, (3 * BOX_WIDTH) / 4);

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      const end = viewEndOf(vi.mocked(fetchStateTimeline).mock.lastCall!, 5 * MINUTE);
      expect(Math.abs(end - (now - 2.5 * MINUTE))).toBeLessThan(5000);
      expect(screen.getByText(/^What the machine did from /)).toBeInTheDocument();
      // The strip keeps the 10 minutes, and no range button shows as pressed while the chart is zoomed in
      expect(screen.getByRole('img', { name: /^Overview of the last 10 minutes/ })).toBeInTheDocument();
      for (const name of ['10m', '1h', '24h', '7d']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    });

    it('shades the highlighted time on the strip and on the chart while the user drags', async () => {
      const overview = await overviewOfStateView();
      const band = await screen.findByRole('img', { name: /^Machine state in the last 10 minutes/ });

      fireEvent.pointerDown(overview, { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(overview, { clientX: 300, pointerId: 1 });

      for (const svg of [overview, band]) {
        // The strip and the chart read the clock at their own times, so the positions can differ by a little
        const shade = svg.querySelector('[data-zoom-highlight]');
        expect(Number(shade?.getAttribute('x'))).toBeCloseTo(100, 0);
        expect(Number(shade?.getAttribute('width'))).toBeCloseTo(200, 0);
      }

      fireEvent.pointerUp(overview, { clientX: 300, pointerId: 1 });
      expect(document.querySelector('[data-zoom-highlight]')).toBeNull();
    });

    it('zooms the line chart into the highlighted time, with finer windows', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: Date.now() - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      const overview = await screen.findByRole('img', { name: /^Overview/ });

      drag(overview, 200, 300);

      await waitFor(() => expect(fetchValueHistory).toHaveBeenLastCalledWith('m1', 'spindle-speed', expect.stringMatching(/^-\d+s$/), '1s', expect.any(Number)));
    });

    it('does not zoom for a drag on the chart, and a range button shows the wider time again', async () => {
      const overview = await overviewOfStateView();

      drag(await screen.findByRole('img', { name: /^Machine state/ }), 300, 302);
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);

      drag(overview, 100, 400);
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole('button', { name: '1h' }));

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenLastCalledWith('m1', '-2h'));
      expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('moves the zoomed time to where the user clicks on the strip', async () => {
      const now = Date.now();
      const overview = await overviewOfStateView();
      drag(overview, BOX_WIDTH / 2, BOX_WIDTH);
      // A zoom that reaches now stays live: it loads 5 minutes and 5 more before them
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenLastCalledWith('m1', '-10m'));

      // A click at 1/4 of the 10 minutes: the 5 minutes go from 10 to 5 minutes ago
      drag(overview, BOX_WIDTH / 4, BOX_WIDTH / 4);

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(3));
      const end = viewEndOf(vi.mocked(fetchStateTimeline).mock.lastCall!, 5 * MINUTE);
      expect(Math.abs(end - (now - 5 * MINUTE))).toBeLessThan(5000);
    });

    it('clears the zoom with the button above the box, back to the time of the strip', async () => {
      const overview = await overviewOfStateView();
      expect(screen.queryByRole('button', { name: 'Clear the zoom' })).not.toBeInTheDocument();
      drag(overview, BOX_WIDTH / 4, (3 * BOX_WIDTH) / 4);
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole('button', { name: 'Clear the zoom' }));

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenLastCalledWith('m1', '-20m'));
      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '10m' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Clear the zoom' })).not.toBeInTheDocument();
    });

    it('reads the timeline once while the strip shows the same time as the chart', async () => {
      await overviewOfStateView();

      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
    });

    it('lines up with the plot of the value chart: the margin is not part of the strip', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: Date.now() - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      const overview = await screen.findByRole('img', { name: /^Overview/ });

      drag(overview, BOX_WIDTH - PLOT_RIGHT_MARGIN / 2, BOX_WIDTH - PLOT_RIGHT_MARGIN / 2);

      expect(fetchValueHistory).toHaveBeenCalledTimes(1);
    });
  });
});
