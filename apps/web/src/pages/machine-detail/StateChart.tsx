import { useState, type PointerEvent } from 'react';
import { useBoxSize } from '../../hooks/useBoxSize';
import { STATE_LABELS } from '../../machines/machineStatus';
import type { Machine } from '../../types';
import { ChartTooltip, TimeLabels } from './ChartParts';
import { messageFor, timeLabels, type ChartRange } from './historyChart';
import { formatDuration, formatShare } from './reportView';
import { StateBand, StateLegend, StateSwatch } from './StateBand';
import { liveStateOf, segmentAt, segmentTimesText, stateTotals, type StateSegment, type StateTotal } from './stateTimeline';
import { useStateTimeline } from './useStateTimeline';

const BAND_HEIGHT = 88;
/** The space between the band and the time labels */
const TIME_LABEL_GAP = 18;
const SVG_HEIGHT = BAND_HEIGHT + TIME_LABEL_GAP + 4;
/** About the width of the hover box, so a box near the right edge stays inside the chart */
const TOOLTIP_WIDTH = 220;
const SECOND_MS = 1000;

/** "40%" of the range, also "0%" for a state that did not occur */
function shareText(ms: number, range: ChartRange): string {
  return formatShare(ms, range.ms) || '0%';
}

/** "12 min", or "under 1 s" for a very short segment */
function lengthText(ms: number): string {
  return ms < SECOND_MS ? 'under 1 s' : formatDuration(ms);
}

/** The machine state over time, as a colored band, with the share of time in each state */
export function StateChart({ machine, range }: { machine: Machine; range: ChartRange }) {
  const { segments, status, now } = useStateTimeline(machine.id, liveStateOf(machine), range);
  const { ref, width } = useBoxSize<HTMLDivElement>();
  const totals = stateTotals(segments);

  if (status !== 'ready') {
    return <p className="m-0 flex h-[13.75rem] items-center justify-center text-center text-zinc-300">{messageFor(status, 'machine state', range)}</p>;
  }

  return (
    <div className="flex min-h-[13.75rem] flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {totals.map(({ state, ms }) => (
          <div key={state} className="flex flex-col gap-0.5 rounded-lg bg-zinc-800/60 px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-zinc-300">
              <StateSwatch state={state} />
              {STATE_LABELS[state]}
            </span>
            <span className="font-mono text-lg font-medium">
              {shareText(ms, range)} <span className="text-xs text-zinc-400">{ms > 0 ? lengthText(ms) : ''}</span>
            </span>
          </div>
        ))}
      </div>
      <div ref={ref} className="relative">
        {width > 0 && <StatePlot segments={segments} totalsText={totalsText(totals, range)} now={now} range={range} width={width} />}
      </div>
      <StateLegend explain className="gap-x-4" />
    </div>
  );
}

/** "Running 40%, Idle 11%, Alarm 1%, Offline 48%", for the screen reader text */
function totalsText(totals: StateTotal[], range: ChartRange): string {
  return totals.map(({ state, ms }) => `${STATE_LABELS[state]} ${shareText(ms, range)}`).join(', ');
}

interface StatePlotProps {
  segments: StateSegment[];
  totalsText: string;
  now: number;
  range: ChartRange;
  width: number;
}

function StatePlot({ segments, totalsText, now, range, width }: StatePlotProps) {
  // The hovered time, not the segment: the live segment grows, so the segment is found again on each render
  const [hoveredTime, setHoveredTime] = useState<number | undefined>();
  const hovered = hoveredTime === undefined ? undefined : segmentAt(segments, hoveredTime);
  const startTime = now - range.ms;
  const x = (time: number) => ((time - startTime) / range.ms) * width;

  const showSegment = (event: PointerEvent<SVGSVGElement>) => {
    const offsetX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    setHoveredTime(startTime + (offsetX / width) * range.ms);
  };

  return (
    <>
      <svg
        width={width}
        height={SVG_HEIGHT}
        role="img"
        aria-label={`Machine state in the last ${range.words}. ${totalsText}.`}
        onPointerMove={showSegment}
        onPointerLeave={() => setHoveredTime(undefined)}
        className="block"
      >
        <rect width={width} height={BAND_HEIGHT} rx={6} className="fill-zinc-800" />
        <StateBand segments={segments} startTime={startTime} rangeMs={range.ms} left={0} width={width} y={0} height={BAND_HEIGHT} />
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
        <TimeLabels labels={timeLabels(range.ms, now)} x={x} y={BAND_HEIGHT + TIME_LABEL_GAP} />
      </svg>
      {hovered && <SegmentTooltip segment={hovered} left={Math.min(Math.max(0, x(hovered.start)), width - TOOLTIP_WIDTH)} />}
    </>
  );
}

/** The state, its times and its length, the program, and the alarm text, in a box over the band */
function SegmentTooltip({ segment, left }: { segment: StateSegment; left: number }) {
  return (
    <ChartTooltip style={{ left }} className="bottom-full mb-2">
      <strong className="flex items-center gap-1.5">
        <StateSwatch state={segment.state} />
        {STATE_LABELS[segment.state]} · {lengthText(segment.end - segment.start)}
      </strong>
      <span className="font-mono text-zinc-300">
        {segmentTimesText(segment.start, segment.end)}
      </span>
      {segment.program && (
        <span className="text-zinc-300">
          Program <span className="font-mono text-zinc-50">{segment.program}</span>
        </span>
      )}
      {segment.detail && <span className="text-alarm-soft">{segment.detail}</span>}
    </ChartTooltip>
  );
}
