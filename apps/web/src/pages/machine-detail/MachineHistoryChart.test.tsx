import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchValueHistory } from '../../api/history';
import { fetchStateTimeline } from '../../api/stateTimeline';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import { CHART_RANGES, viewText } from './historyChart';
import { chartChoicesFor, shownChartChoice, SPINDLE_SPEED, type ChartChoiceId } from './chartValues';
import MachineHistoryChart from './MachineHistoryChart';

/** The width that the fake ResizeObserver gives each chart box */
const BOX_WIDTH = 600;
/** The plot starts this far from the left edge of the box (MARGIN.left in the chart) */
const PLOT_LEFT_MARGIN = 52;
/** The plot ends this far from the right edge of the box (MARGIN.right in the chart) */
const PLOT_RIGHT_MARGIN = 16;
const MINUTE = 60_000;
/** The clock of each test stops at this time, so the times in the texts are known */
const NOW = Date.UTC(2026, 10, 19, 12, 0);

/** The words of a chart that ends at `end` in the past, for example "from Nov 19, 11:45 AM to Nov 19, 11:55 AM" */
function pastText(rangeMs: number, end: number): string {
  return viewText({ ...CHART_RANGES[0], ms: rangeMs }, end);
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
    // Only the date stops. The timers run, so waitFor and the chart clock work as usual.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
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
    vi.useRealTimers();
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

  it('offers the machine state in the menu, also when the machine sends only the spindle speed', async () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200 })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Value in the chart: Spindle speed' }));

    expect(await screen.findByRole('menuitem', { name: 'Machine state' })).toBeInTheDocument();
  });

  it('loads the history of the value that the user picks', async () => {
    render(<ChartWithMenu machine={testMachine({}, { spindleSpeed: 1200, spindleLoad: 30 })} />);
    expect(vi.mocked(fetchValueHistory).mock.lastCall?.[1]).toBe('spindle-speed');

    const valueButton = screen.getByRole('button', { name: 'Value in the chart: Spindle speed' });
    // The menu trigger is the button itself, not a second button around it
    expect(valueButton.parentElement?.closest('[role=button], button')).toBeNull();
    fireEvent.click(valueButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spindle load' }));

    await waitFor(() => expect(vi.mocked(fetchValueHistory).mock.lastCall?.[1]).toBe('spindle-load'));
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

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalled());
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

      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));

      expect(await screen.findByText(`How fast the spindle turned ${pastText(10 * MINUTE, NOW - 5 * MINUTE)}.`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Later' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Now' }));

      expect(await screen.findByText('How fast the spindle turned in the last 10 minutes.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();
    });

    it('moves the time with a sideways scroll, but not with an up or down scroll', async () => {
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(1));

      fireEvent.wheel(chartBody(), { deltaX: 0, deltaY: 200 });
      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();

      // A quarter of the range back
      fireEvent.wheel(chartBody(), { deltaX: -80, deltaY: 0 });
      expect(await screen.findByText(`What the machine did ${pastText(10 * MINUTE, NOW - 2.5 * MINUTE)}.`)).toBeInTheDocument();
    });

    it('stops a sideways scroll on the chart, so the browser does not go back a page', async () => {
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(1));

      // fireEvent gives false when the page stopped the default action of the event
      expect(fireEvent.wheel(chartBody(), { deltaX: -20, deltaY: 0 })).toBe(false);
      expect(fireEvent.wheel(chartBody(), { deltaX: 0, deltaY: 200 })).toBe(true);
    });

    it('moves the time when the user drags the chart: to the right goes back', async () => {
      await overviewOfStateView();

      drag(chartBody(), 100, 100 + BOX_WIDTH / 2);

      expect(await screen.findByText(`What the machine did ${pastText(10 * MINUTE, NOW - 5 * MINUTE)}.`)).toBeInTheDocument();
    });

    it('shows the time before the chart while the user drags, and keeps it while the new time loads', async () => {
      // The chart loads 20 minutes: the alarm is before the 10 minutes that show
      vi.mocked(fetchStateTimeline).mockResolvedValue([
        { state: 'alarm', start: NOW - 20 * MINUTE, end: NOW - 10 * MINUTE },
        { state: 'running', start: NOW - 10 * MINUTE, end: NOW },
      ]);
      render(<ChartWithMenu machine={runningMachine()} start="machine-state" />);
      expect(await screen.findByRole('img', { name: /Running 100%, Idle 0%, Alarm 0%/ })).toBeInTheDocument();

      fireEvent.pointerDown(chartBody(), { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(chartBody(), { clientX: 100 + BOX_WIDTH / 2, pointerId: 1 });

      const shownWhileDragged = `Machine state ${pastText(10 * MINUTE, NOW - 5 * MINUTE)}. Running 50%, Idle 0%, Alarm 50%, Offline 0%.`;
      expect(screen.getByRole('img', { name: shownWhileDragged })).toBeInTheDocument();
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);

      vi.mocked(fetchStateTimeline).mockReturnValue(new Promise(() => {}));
      fireEvent.pointerUp(chartBody(), { clientX: 100 + BOX_WIDTH / 2, pointerId: 1 });

      await waitFor(() => expect(fetchStateTimeline).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('img', { name: shownWhileDragged })).toBeInTheDocument();
    });

    it('does not move the time for a click, or for a drag of the live chart into the future', async () => {
      await overviewOfStateView();

      drag(chartBody(), 300, 302);
      drag(chartBody(), 300, 100);

      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
    });

    it('does not drag a chart in the past after now', async () => {
      await overviewOfStateView();
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
      await screen.findByText(`What the machine did ${pastText(10 * MINUTE, NOW - 5 * MINUTE)}.`);

      // A drag of the full width to the left goes 10 minutes on, but the chart stops at now
      fireEvent.pointerDown(chartBody(), { button: 0, clientX: BOX_WIDTH, pointerId: 1 });
      fireEvent.pointerMove(chartBody(), { clientX: 0, pointerId: 1 });

      expect(screen.getByRole('img', { name: name => name.startsWith(`Machine state ${pastText(10 * MINUTE, NOW)}.`) })).toBeInTheDocument();
    });

    it('moves the live chart from the time that it draws, also when the clock of the machine is ahead', async () => {
      // The page clock is 12:00:50. The last value came at 12:01:10 by the clock of Chatter, so the chart ends then.
      vi.setSystemTime(NOW + 50_000);
      const machine = testMachine({ connected: true, lastPollTime: new Date(NOW + 70_000).toISOString() }, { spindleSpeed: 1200 });
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: NOW, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={machine} />);
      await screen.findByRole('img', { name: /^Spindle speed in the last 10 minutes/ });

      // Half the plot: 5 minutes back from 12:01:10
      const plotWidth = BOX_WIDTH - PLOT_LEFT_MARGIN - PLOT_RIGHT_MARGIN;
      drag(chartBody(), 100, 100 + plotWidth / 2);

      expect(await screen.findByText(`How fast the spindle turned ${pastText(10 * MINUTE, NOW + 70_000 - 5 * MINUTE)}.`)).toBeInTheDocument();
    });

    it('does not move the time when the browser cancels a drag, for example to scroll the page on a touch screen', async () => {
      await overviewOfStateView();
      const body = chartBody();

      fireEvent.pointerDown(body, { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(body, { clientX: 400, pointerId: 1 });
      fireEvent.pointerCancel(body, { clientX: 400, pointerId: 1 });
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: /^Machine state in the last 10 minutes/ })).toBeInTheDocument();
      expect(body).toHaveClass('cursor-grab');
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
    });

    it('shows a closed hand while the user holds the chart', async () => {
      await overviewOfStateView();
      const body = chartBody();
      expect(body).toHaveClass('cursor-grab');

      fireEvent.pointerDown(body, { button: 0, clientX: 300, pointerId: 1 });
      expect(body).toHaveClass('cursor-grabbing');

      fireEvent.pointerUp(body, { clientX: 300, pointerId: 1 });
      expect(body).toHaveClass('cursor-grab');
    });

    it('goes back to the live chart when the user picks another range', async () => {
      render(<ChartWithMenu machine={runningMachine()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Now' })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: '1h' }));

      expect(await screen.findByText('How fast the spindle turned in the last hour.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Now' })).toBeDisabled();
    });
  });

  describe('zooming in on the overview strip', () => {
    it('shows the time that the user highlights on the strip', async () => {
      const overview = await overviewOfStateView();

      // From 1/4 to 3/4 of the 10-minute strip: 5 minutes that end 2.5 minutes ago
      drag(overview, BOX_WIDTH / 4, (3 * BOX_WIDTH) / 4);

      expect(await screen.findByText(`What the machine did ${pastText(5 * MINUTE, NOW - 2.5 * MINUTE)}.`)).toBeInTheDocument();
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
        const shade = svg.querySelector('[data-zoom-highlight]');
        expect(Number(shade?.getAttribute('x'))).toBeCloseTo(100, 6);
        expect(Number(shade?.getAttribute('width'))).toBeCloseTo(200, 6);
      }

      fireEvent.pointerUp(overview, { clientX: 300, pointerId: 1 });
      expect(document.querySelector('[data-zoom-highlight]')).toBeNull();
    });

    it('zooms the line chart into the highlighted time, with finer windows', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: NOW - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      const overview = await screen.findByRole('img', { name: /^Overview/ });

      drag(overview, 200, 300);

      expect(await screen.findByText(/^How fast the spindle turned from /)).toBeInTheDocument();
      // About 2 minutes in about 300 windows
      expect(vi.mocked(fetchValueHistory).mock.lastCall?.[3]).toBe('1s');
    });

    it('shows the wider time again with a range button after a zoom', async () => {
      const overview = await overviewOfStateView();
      drag(overview, 100, 400);
      expect(await screen.findByText(/^What the machine did from /)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '1h' }));

      expect(await screen.findByText('What the machine did in the last hour.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('moves the zoomed time to where the user clicks on the strip', async () => {
      const overview = await overviewOfStateView();
      // A zoom that reaches now stays live
      drag(overview, BOX_WIDTH / 2, BOX_WIDTH);
      expect(await screen.findByText('What the machine did in the last 5 minutes.')).toBeInTheDocument();

      // A click at 1/4 of the 10 minutes: the 5 minutes go from 10 to 5 minutes ago
      drag(overview, BOX_WIDTH / 4, BOX_WIDTH / 4);

      expect(await screen.findByText(`What the machine did ${pastText(5 * MINUTE, NOW - 5 * MINUTE)}.`)).toBeInTheDocument();
    });

    it('stays live for a zoom to the right end of the strip, also between two ticks of the chart clock', async () => {
      const overview = await overviewOfStateView();
      // The page clock goes on 3 seconds. The chart clock ticks every 5 seconds, so the strip still ends at NOW.
      vi.setSystemTime(NOW + 3000);

      drag(overview, BOX_WIDTH / 2, BOX_WIDTH);

      expect(await screen.findByText('What the machine did in the last 5 minutes.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Now' })).toBeDisabled();
    });

    it('does not move a live chart into the past for a click on the strip, also when the clock of Chatter is ahead', async () => {
      // The clock of Chatter is 4 seconds ahead of the page clock
      const chatterNow = NOW + 4000;
      vi.mocked(fetchStateTimeline).mockResolvedValue([{ state: 'running', program: 'O1001', start: NOW - 10 * MINUTE, end: chatterNow }]);
      const machine = testMachine(
        { connected: true, lastPollTime: new Date(chatterNow).toISOString() },
        { spindleSpeed: 1200, execution: 'ACTIVE', program: 'O1001' },
      );
      render(<ChartWithMenu machine={machine} start="machine-state" />);
      const overview = await screen.findByRole('img', { name: /^Overview of the last 10 minutes/ });

      // A click right of the middle of the box. The chart ends now, so it cannot go on.
      drag(overview, (5 * BOX_WIDTH) / 6, (5 * BOX_WIDTH) / 6);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(screen.getByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
    });

    it('clears the zoom with the button above the box, back to the time of the strip', async () => {
      const overview = await overviewOfStateView();
      expect(screen.queryByRole('button', { name: 'Clear the zoom' })).not.toBeInTheDocument();
      drag(overview, BOX_WIDTH / 4, (3 * BOX_WIDTH) / 4);
      await screen.findByText(/^What the machine did from /);

      fireEvent.click(screen.getByRole('button', { name: 'Clear the zoom' }));

      expect(await screen.findByText('What the machine did in the last 10 minutes.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '10m' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Clear the zoom' })).not.toBeInTheDocument();
    });

    it('reads the timeline once while the strip shows the same time as the chart', async () => {
      await overviewOfStateView();

      expect(fetchStateTimeline).toHaveBeenCalledTimes(1);
    });

    it('lines up with the plot of the value chart: the margin is not part of the strip', async () => {
      vi.mocked(fetchValueHistory).mockResolvedValue({ points: [{ time: NOW - MINUTE, value: 1000 }], window: '5s' });
      render(<ChartWithMenu machine={runningMachine()} />);
      const overview = await screen.findByRole('img', { name: /^Overview/ });
      // A zoom in the past, so a click at the right end of the strip moves the chart
      drag(overview, 100, 200);
      await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledTimes(2));

      drag(overview, BOX_WIDTH - PLOT_RIGHT_MARGIN / 2, BOX_WIDTH - PLOT_RIGHT_MARGIN / 2);
      expect(fetchValueHistory).toHaveBeenCalledTimes(2);

      drag(overview, BOX_WIDTH - PLOT_RIGHT_MARGIN - 1, BOX_WIDTH - PLOT_RIGHT_MARGIN - 1);
      await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledTimes(3));
    });
  });
});
