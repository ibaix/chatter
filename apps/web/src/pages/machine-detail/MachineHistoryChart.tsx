import { historyWindowValue } from '@local-chatter/shared';
import { cn } from '@toolpath/ui';
import { useEffect, useId, useState, type PointerEvent, type RefObject } from 'react';
import type { HistoryPoint } from '../../api/history';
import { CHOICE_HEIGHT, ChoiceMenu } from '../../components/ui/ChoiceMenu';
import { RangeButtons } from '../../components/ui/RangeButtons';
import { useBoxSize } from '../../hooks/useBoxSize';
import { STATE_LABELS } from '../../machines/machineStatus';
import type { Machine } from '../../types';
import { ChartOverview } from './ChartOverview';
import { AXIS_LABEL_CLASS, ChartTooltip, offsetXOf, PanButtons, TimeLabels, ZoomHighlight, type ZoomSelection } from './ChartParts';
import { MACHINE_STATE, type ChartChoice, type ChartChoiceId, type ChartValue } from './chartValues';
import {
  axisTicks,
  CHART_RANGES,
  formatChartNumber,
  lineParts,
  messageFor,
  nearestPoint,
  stepPoints,
  timeLabels,
  timeScale,
  viewText,
  type ChartRange,
  type TimeScale,
} from './historyChart';
import { StateBand, StateLegend, StateSwatch } from './StateBand';
import { StateChart } from './StateChart';
import { liveStateOf, segmentAt, type StateSegment } from './stateTimeline';
import { useChartDrag } from './useChartDrag';
import { useChartHistory } from './useChartHistory';
import { useChartView } from './useChartView';
import { useStateTimeline } from './useStateTimeline';

const MARGIN = { top: 12, right: 16, bottom: 38, left: 52 };
/** The machine state strip under the plot, above the time labels */
const STRIP_GAP = 5;
const STRIP_HEIGHT = 6;
/** The Earlier and Later buttons move the time by half the range */
const BUTTON_STEP = 0.5;
/** The space between a value label and the left end of its grid line */
const VALUE_LABEL_GAP = 8;
/** The distance from the bottom of the chart to the time labels */
const TIME_LABEL_BOTTOM = 6;
/** The space between the hover line and the tooltip */
const TOOLTIP_GAP = 12;
/** About the width of the tooltip, so a tooltip near the right edge stays inside the chart */
const TOOLTIP_WIDTH = 190;
/**
 * The newest value from the live machine events, or null when the machine is not connected.
 * A connecting machine has old values (also while the page cannot reach Chatter), so it gives none.
 */
function livePointOf(machine: Machine, value: ChartValue): HistoryPoint | null {
  const liveValue = value.liveValueOf(machine);
  if (!machine.connected || machine.connecting || !machine.lastPollTime || liveValue === undefined) return null;
  return { time: Date.parse(machine.lastPollTime), value: liveValue };
}

interface MachineHistoryChartProps {
  machine: Machine;
  /** The choices that the menu offers */
  choices: ChartChoice[];
  /** The choice that the chart shows */
  choice: ChartChoice;
  onChoose: (id: ChartChoiceId) => void;
  className?: string;
}

/** One machine value, or the machine state, over time, with a menu for the value and buttons for the time range */
function MachineHistoryChart({ machine, choices, choice, onChoose, className }: MachineHistoryChartProps) {
  const { view, pick, moveBy, pan, showNow, zoomTo, clearZoom, zoomed } = useChartView();
  const { range, end } = view;
  const isStateChart = choice.id === MACHINE_STATE.id;
  const drag = useChartDrag({ rangeMs: range.ms, end, margins: isStateChart ? 0 : MARGIN.left + MARGIN.right, onMove: moveBy });
  const { shiftMs } = drag;

  /** The time that the user highlights on the overview strip. The chart shades it also. */
  const [selection, setSelection] = useState<ZoomSelection | null>(null);

  return (
    <section
      aria-label={`${choice.name} chart`}
      className={cn('flex min-w-0 flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <ChartTitle choices={choices} choice={choice} onChoose={onChoose} />
          <span className="text-xs text-zinc-300">{choice.description} {viewText(range, end)}.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PanButtons
            canGoLater={end !== null}
            onEarlier={() => pan(-BUTTON_STEP)}
            onLater={() => pan(BUTTON_STEP)}
            onNow={showNow}
          />
          <RangeButtons options={CHART_RANGES} value={range} onChange={pick} />
        </div>
      </div>
      <div
        role="group"
        aria-label="Chart: drag or scroll sideways to move in time"
        ref={drag.bodyRef}
        {...drag.handlers}
        className={cn('flex touch-pan-y flex-col gap-2.5 overflow-hidden select-none', drag.dragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
        {isStateChart ? (
          <StateChart machine={machine} range={range} end={end} shiftMs={shiftMs} drawnNow={drag.drawnNow} selection={selection} />
        ) : (
          <ValueChart machine={machine} value={choice} range={range} end={end} shiftMs={shiftMs} drawnNow={drag.drawnNow} selection={selection} />
        )}
      </div>
      <ChartOverview
        machine={machine}
        overview={view.overview}
        overviewEnd={view.overviewEnd}
        view={range}
        viewEnd={shiftMs ? (end ?? Date.now()) + shiftMs : end}
        selection={selection}
        onSelect={setSelection}
        left={isStateChart ? 0 : MARGIN.left}
        right={isStateChart ? 0 : MARGIN.right}
        onMove={moveBy}
        onZoom={zoomTo}
        onClearZoom={zoomed ? clearZoom : undefined}
      />
    </section>
  );
}

interface ValueChartProps {
  machine: Machine;
  value: ChartValue;
  range: ChartRange;
  end: number | null;
  /** How far a drag moves the time, in milliseconds: negative goes back. The chart loaded this time already. */
  shiftMs: number;
  /** The chart sets this to the end that it draws, so a drag ends where the chart drew it */
  drawnNow: RefObject<number | null>;
  /** The time that the user highlights on the overview strip */
  selection: ZoomSelection | null;
}

/** A machine value as a line, with the machine state as a thin strip under it */
function ValueChart({ machine, value, range, end, shiftMs, drawnNow, selection }: ValueChartProps) {
  const livePoint = livePointOf(machine, value);
  const { points, status, now, gapMs } = useChartHistory(machine.id, value.id, livePoint, range, end);
  useEffect(() => { drawnNow.current = now; });
  // The chart's clock, so the strip ends where the line ends
  const { segments: stripSegments, status: stateStatus } = useStateTimeline(machine.id, liveStateOf(machine), range, now, end);
  const { ref, width, height } = useBoxSize<HTMLDivElement>();
  // The chart keeps the old points while a new time loads. They show only when some of them are in the time that shows.
  const shownEnd = now + shiftMs;
  const hasShownPoints = points.some(point => point.time >= shownEnd - range.ms && point.time <= shownEnd);
  const showPlot = status !== 'failed' && hasShownPoints && width > 0;

  return (
    <>
      {/* The box sets the chart height in rem, so the chart follows the page scale */}
      <div ref={ref} className="relative h-[13.75rem]">
        {showPlot ? (
          <ChartPlot
            points={points}
            value={value}
            stateSegments={stripSegments}
            now={now}
            shiftMs={shiftMs}
            range={range}
            gapMs={gapMs}
            connected={machine.connected && end === null}
            live={end === null}
            selection={selection}
            width={width}
            height={height}
          />
        ) : (
          <p className="m-0 flex h-full items-center justify-center text-center text-zinc-300">{messageFor(status, value.name, range, end)}</p>
        )}
        {showPlot && status === 'loading' && (
          <span role="status" className="absolute top-0 text-xs text-zinc-400" style={{ right: MARGIN.right }}>Loading…</span>
        )}
      </div>
      {showPlot && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ marginLeft: MARGIN.left }}>
          {/* A failed load leaves only the live state in the strip, so the legend would tell too little */}
          {stateStatus === 'failed' ? (
            <span className="text-zinc-300">Could not load the machine state. Reload the page to try again.</span>
          ) : (
            <>
              <span aria-hidden="true" className="text-zinc-400">Machine state:</span>
              <StateLegend />
            </>
          )}
        </div>
      )}
    </>
  );
}

interface ChartTitleProps {
  choices: ChartChoice[];
  choice: ChartChoice;
  onChoose: (id: ChartChoiceId) => void;
}

/** The name of the choice, as a dropdown. The unit is next to it. */
function ChartTitle({ choices, choice, onChoose }: ChartTitleProps) {
  const unit = 'unit' in choice ? choice.unit : undefined;
  return (
    <h2 className="m-0 flex items-center gap-1.5 text-base font-bold">
      <ChoiceMenu label="Value in the chart" choices={choices} value={choice.id} onChoose={onChoose} />
      {unit && (
        <span className={cn(CHOICE_HEIGHT, 'inline-flex items-center rounded bg-zinc-800 px-1.5 font-mono text-[0.6875rem] font-medium text-zinc-200')}>
          {unit}
        </span>
      )}
    </h2>
  );
}

interface ChartPlotProps {
  points: HistoryPoint[];
  /** False when the chart looks back in time, so its end is not "Now" */
  live: boolean;
  selection: ZoomSelection | null;
  value: ChartValue;
  /** The machine state over the range, for the strip under the plot */
  stateSegments: StateSegment[];
  now: number;
  /** How far a drag moves the time that shows, in milliseconds */
  shiftMs: number;
  range: ChartRange;
  gapMs: number;
  connected: boolean;
  width: number;
  height: number;
}

function ChartPlot({ points, value, stateSegments, now, shiftMs, range, gapMs, connected, live, selection, width, height }: ChartPlotProps) {
  const [hovered, setHovered] = useState<HistoryPoint | undefined>();
  const clipId = useId();
  // The axis is of all the loaded points, so it does not jump while the user drags
  const ticks = axisTicks(highestValue(points), value.smallestAxisTop);
  /** The end of the time that shows, also while the user drags */
  const shownEnd = now + shiftMs;
  const shownLive = live && shiftMs === 0;
  const startTime = shownEnd - range.ms;
  const scale = chartScale({ width, height, startTime, rangeMs: range.ms, topValue: ticks[ticks.length - 1] });
  const parts = lineParts(points, now, connected, gapMs);
  // A counter or a tool number holds its value until it changes, so it draws as steps
  const drawnParts = historyWindowValue(value.id) === 'last' ? parts.map(stepPoints) : parts;
  // The chart loads time after a chart in the past, so the newest point that shows can be before the last point
  const newest = points.filter(point => point.time <= shownEnd).at(-1) ?? points[0];

  const showNearest = (event: PointerEvent<SVGSVGElement>) => {
    const offsetX = offsetXOf(event);
    const shownPoints = points.filter(point => point.time >= startTime && point.time <= shownEnd);
    setHovered(nearestPoint(shownPoints, scale.timeAt(offsetX)));
  };

  return (
    <>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${value.name} ${viewText(range, shownLive ? null : shownEnd)}. Newest value: ${value.format(newest.value)}.`}
        onPointerMove={showNearest}
        onPointerLeave={() => setHovered(undefined)}
        className="block"
      >
        <defs>
          {/* The chart loads more time than it shows, so the line stays inside the plot */}
          <clipPath id={clipId}>
            <rect x={MARGIN.left} y={0} width={width - MARGIN.left - MARGIN.right} height={height} />
          </clipPath>
        </defs>
        <ValueAxis ticks={ticks} scale={scale} width={width} />
        <TimeLabels labels={timeLabels(range.ms, shownEnd, shownLive)} x={scale.x} y={height - TIME_LABEL_BOTTOM} />
        <g clipPath={`url(#${clipId})`}>
          {drawnParts.map(part =>
            part.length === 1 ? (
              // A value with no neighbor in its part has no line, so it shows as a dot
              <circle key={part[0].time} cx={scale.x(part[0].time)} cy={scale.y(part[0].value)} r={2.5} className="fill-primary" />
            ) : (
              <path key={part[0].time} d={linePath(part, scale)} fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-primary" />
            ),
          )}
        </g>
        <StateBand
          segments={stateSegments}
          startTime={startTime}
          rangeMs={range.ms}
          left={MARGIN.left}
          width={width - MARGIN.left - MARGIN.right}
          y={scale.y(0) + STRIP_GAP}
          height={STRIP_HEIGHT}
        />
        {hovered && <HoverMarker point={hovered} scale={scale} />}
        <ZoomHighlight selection={selection} x={scale.x} left={MARGIN.left} right={width - MARGIN.right} height={scale.y(0)} />
      </svg>
      {hovered && (
        <HoverTooltip
          point={hovered}
          value={value}
          segment={segmentAt(stateSegments, hovered.time)}
          left={Math.min(scale.x(hovered.time) + TOOLTIP_GAP, width - TOOLTIP_WIDTH)}
        />
      )}
    </>
  );
}

function highestValue(points: HistoryPoint[]): number {
  return points.reduce((highest, point) => Math.max(highest, point.value), 0);
}

interface ChartScale extends TimeScale {
  /** The y position of a value */
  y: (value: number) => number;
}

interface ChartScaleOptions {
  width: number;
  height: number;
  /** The time at the left edge of the plot */
  startTime: number;
  rangeMs: number;
  /** The value at the top of the plot */
  topValue: number;
}

/** Turns times and values into positions in the chart, inside the margins */
function chartScale({ width, height, startTime, rangeMs, topValue }: ChartScaleOptions): ChartScale {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  return {
    ...timeScale(startTime, rangeMs, MARGIN.left, plotWidth),
    y: value => MARGIN.top + plotHeight - (value / topValue) * plotHeight,
  };
}

/** The SVG path of one part of the line: "M" to its first point, then "L" to each next point */
function linePath(part: HistoryPoint[], scale: ChartScale): string {
  return part.map((point, index) => `${index ? 'L' : 'M'}${scale.x(point.time)},${scale.y(point.value)}`).join('');
}

/** A grid line and a label for each value on the value axis. The line at 0 is brighter. */
function ValueAxis({ ticks, scale, width }: { ticks: number[]; scale: ChartScale; width: number }) {
  return (
    <>
      {ticks.map(tick => {
        const tickY = scale.y(tick);
        return (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={tickY}
              y2={tickY}
              className={tick === 0 ? 'stroke-zinc-500' : 'stroke-zinc-800'}
              strokeWidth={1}
            />
            <text x={MARGIN.left - VALUE_LABEL_GAP} y={tickY} textAnchor="end" dominantBaseline="middle" className={AXIS_LABEL_CLASS}>
              {formatChartNumber(tick, true)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** A line down from the top of the plot, and a dot on the hovered point */
function HoverMarker({ point, scale }: { point: HistoryPoint; scale: ChartScale }) {
  const pointX = scale.x(point.time);
  return (
    <>
      <line x1={pointX} x2={pointX} y1={MARGIN.top} y2={scale.y(0)} strokeWidth={1} className="stroke-zinc-400" />
      <circle cx={pointX} cy={scale.y(point.value)} r={4} strokeWidth={2} className="fill-primary stroke-zinc-900" />
    </>
  );
}

interface HoverTooltipProps {
  point: HistoryPoint;
  value: ChartValue;
  /** The machine state and program at the time of the point, when they are known */
  segment?: StateSegment;
  left: number;
}

/** The value and the time of the hovered point, and the machine state and program then, in a box over the chart */
function HoverTooltip({ point, value, segment, left }: HoverTooltipProps) {
  return (
    <ChartTooltip style={{ left, top: MARGIN.top }}>
      <strong className="font-mono">{value.format(point.value)}</strong>
      <span className="text-zinc-300">{new Date(point.time).toLocaleString()}</span>
      {segment && (
        <span className="flex items-center gap-1.5 text-zinc-300">
          <StateSwatch state={segment.state} />
          {STATE_LABELS[segment.state]}
          {segment.program && <span className="font-mono text-zinc-50">{segment.program}</span>}
        </span>
      )}
    </ChartTooltip>
  );
}

export default MachineHistoryChart;
