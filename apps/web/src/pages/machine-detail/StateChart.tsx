import { useState, type PointerEvent } from 'react';
import { useBoxSize } from '../../hooks/useBoxSize';
import { machineStateOf } from '../../machines/machineStatus';
import type { Machine } from '../../types';
import { formatDuration, formatShare } from './reportView';
import { messageFor, timeLabelAnchor, timeLabels, type ChartRange } from './historyChart';
import { StateBand, StateSwatch, TIMELINE_STATE_LABELS } from './StateBand';
import { segmentAt, stateTotals, timelineStateOf, type StateSegment } from './stateTimeline';
import { useStateTimeline } from './useStateTimeline';

const BAND_HEIGHT = 48;
/** The space between the band and the time labels */
const TIME_LABEL_GAP = 18;
const SVG_HEIGHT = BAND_HEIGHT + TIME_LABEL_GAP + 4;
/** About the width of the hover box, so a box near the right edge stays inside the chart */
const TOOLTIP_WIDTH = 220;

const LEGEND_TEXT = {
  running: 'Running: a program runs',
  idle: 'Idle: connected, no program runs',
  alarm: 'Alarm: shows over Running',
  offline: 'Offline: no answer, or Chatter was off',
} as const;

/** The machine state over time, as a colored band, with the share of time in each state */
export function StateChart({ machine, range }: { machine: Machine; range: ChartRange }) {
  const live = timelineStateOf(machineStateOf(machine));
  const { segments, status, now } = useStateTimeline(machine.id, live, range);
  const { ref, width } = useBoxSize<HTMLDivElement>();
  const totals = stateTotals(segments);

  if (status !== 'ready' && segments.length === 0) {
    return <p className="m-0 flex h-[13.75rem] items-center justify-center text-center text-zinc-300">{messageFor(status, 'machine state', range)}</p>;
  }

  return (
    <div className="flex min-h-[13.75rem] flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {totals.map(({ state, ms }) => (
          <div key={state} className="flex flex-col gap-0.5 rounded-lg bg-zinc-800/60 px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-zinc-300">
              <StateSwatch state={state} />
              {TIMELINE_STATE_LABELS[state]}
            </span>
            <span className="font-mono text-lg font-medium">
              {formatShare(ms, range.ms) || '0%'} <span className="text-xs text-zinc-400">{ms > 0 ? formatDuration(ms) : ''}</span>
            </span>
          </div>
        ))}
      </div>
      <div ref={ref} className="relative">
        {width > 0 && <StatePlot segments={segments} totalsText={totalsText(totals, range)} now={now} range={range} width={width} />}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-zinc-300">
        {totals.map(({ state }) => (
          <li key={state} className="inline-flex items-center gap-1.5">
            <StateSwatch state={state} />
            {LEGEND_TEXT[state]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Running 40%, Idle 11%, Alarm 1%, Offline 48%", for the screen reader text */
function totalsText(totals: ReturnType<typeof stateTotals>, range: ChartRange): string {
  return totals.map(({ state, ms }) => `${TIMELINE_STATE_LABELS[state]} ${formatShare(ms, range.ms) || '0%'}`).join(', ');
}

interface StatePlotProps {
  segments: StateSegment[];
  totalsText: string;
  now: number;
  range: ChartRange;
  width: number;
}

function StatePlot({ segments, totalsText, now, range, width }: StatePlotProps) {
  const [hovered, setHovered] = useState<StateSegment | undefined>();
  const startTime = now - range.ms;
  const x = (time: number) => ((time - startTime) / range.ms) * width;
  const labels = timeLabels(range.ms, now);

  const showSegment = (event: PointerEvent<SVGSVGElement>) => {
    const offsetX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    setHovered(segmentAt(segments, startTime + (offsetX / width) * range.ms));
  };

  return (
    <>
      <svg
        width={width}
        height={SVG_HEIGHT}
        role="img"
        aria-label={`Machine state in the last ${range.words}. ${totalsText}.`}
        onPointerMove={showSegment}
        onPointerLeave={() => setHovered(undefined)}
        className="block"
      >
        <rect width={width} height={BAND_HEIGHT} rx={6} className="fill-zinc-800" />
        <StateBand segments={segments} x={x} y={0} height={BAND_HEIGHT} />
        {hovered && (
          <rect
            x={x(hovered.start)}
            y={0.5}
            width={Math.max(1, x(hovered.end) - x(hovered.start))}
            height={BAND_HEIGHT - 1}
            fill="none"
            strokeWidth={1.5}
            className="stroke-zinc-50"
          />
        )}
        {labels.map(({ time, text }, index) => (
          <text
            key={index}
            x={x(time)}
            y={BAND_HEIGHT + TIME_LABEL_GAP}
            textAnchor={timeLabelAnchor(index, labels.length)}
            className="fill-zinc-300 font-mono text-[0.6875rem]"
          >
            {text}
          </text>
        ))}
      </svg>
      {hovered && <SegmentTooltip segment={hovered} left={Math.min(Math.max(0, x(hovered.start)), width - TOOLTIP_WIDTH)} />}
    </>
  );
}

/** The state, its times and its length, and the alarm text, in a box over the band */
function SegmentTooltip({ segment, left }: { segment: StateSegment; left: number }) {
  return (
    <div
      className="pointer-events-none absolute bottom-full mb-2 flex flex-col gap-0.5 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs"
      style={{ left }}
    >
      <strong className="flex items-center gap-1.5">
        <StateSwatch state={segment.state} />
        {TIMELINE_STATE_LABELS[segment.state]} · {formatDuration(segment.end - segment.start)}
      </strong>
      <span className="font-mono text-zinc-300">
        {new Date(segment.start).toLocaleString()} – {new Date(segment.end).toLocaleTimeString()}
      </span>
      {segment.detail && <span className="text-alarm-soft">{segment.detail}</span>}
    </div>
  );
}
