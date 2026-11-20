import { cn } from '@toolpath/ui';
import { useState, type PointerEvent } from 'react';
import { useBoxSize } from '../../hooks/useBoxSize';
import type { Machine } from '../../types';
import { TimeLabels } from './ChartParts';
import { timeLabels, viewText, type ChartRange } from './historyChart';
import { StateBand } from './StateBand';
import { liveStateOf, type StateSegment } from './stateTimeline';
import { useStateTimeline } from './useStateTimeline';

const BAND_HEIGHT = 16;
/** The space between the band and the time labels */
const TIME_LABEL_GAP = 15;
const SVG_HEIGHT = BAND_HEIGHT + TIME_LABEL_GAP + 3;
/** A press this near to an edge of the box, in pixels, moves that edge */
const EDGE_PX = 6;
/** The box is at least this wide while the user drags an edge, so the edges do not cross */
const MIN_BOX_PX = 4;

interface ChartOverviewProps {
  machine: Machine;
  /** The range button that the user picked last. The strip shows this much time. */
  overview: ChartRange;
  /** The end of the strip, or null for a strip that ends now */
  overviewEnd: number | null;
  /** The time in the chart, which the box shows */
  view: ChartRange;
  viewEnd: number | null;
  /** The space left and right of the band, so the band lines up with the plot above it */
  left: number;
  right: number;
  /** Moves the time of the chart by `deltaMs`: negative goes back */
  onMove: (deltaMs: number) => void;
  /** Shows the time from `from` to `to` in the chart */
  onZoom: (from: number, to: number) => void;
}

/**
 * A thin machine state band of the full range under the chart, with a box on the time that the chart shows.
 * Drag the box to move in time, drag an edge of the box to zoom, or click the band to move the box there.
 */
export function ChartOverview({ machine, overview, overviewEnd, ...plotProps }: ChartOverviewProps) {
  const { segments, now } = useStateTimeline(machine.id, liveStateOf(machine), overview, undefined, overviewEnd);
  const { ref, width } = useBoxSize<HTMLDivElement>();
  return (
    <div ref={ref}>
      {width > 0 && (
        <OverviewPlot segments={segments} overview={overview} live={overviewEnd === null} now={now} width={width} {...plotProps} />
      )}
    </div>
  );
}

type DragKind = 'move' | 'left' | 'right';

interface Drag {
  kind: DragKind;
  /** Where the pointer went down */
  startX: number;
  /** The time in the box when the drag started */
  from: number;
  to: number;
  /** True when the press was outside the box, so the box went there: the release changes the chart also with no move */
  jumped: boolean;
}

interface OverviewPlotProps extends Omit<ChartOverviewProps, 'machine' | 'overviewEnd'> {
  segments: StateSegment[];
  live: boolean;
  now: number;
  width: number;
}

function OverviewPlot({ segments, overview, live, now, width, view, viewEnd, left, right, onMove, onZoom }: OverviewPlotProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const bandWidth = width - left - right;
  const startTime = now - overview.ms;
  const msPerPx = overview.ms / bandWidth;
  const x = (time: number) => left + (time - startTime) / msPerPx;
  const viewTo = viewEnd ?? now;
  const viewFrom = viewTo - view.ms;

  /** The time in the box while the user drags. The box cannot go after now, and an edge stays in the band. */
  const boxAt = (current: Drag, pointer: number) => {
    const delta = (pointer - current.startX) * msPerPx;
    const minMs = MIN_BOX_PX * msPerPx;
    if (current.kind === 'left') {
      return { from: Math.min(Math.max(current.from + delta, startTime), current.to - minMs), to: current.to };
    }
    if (current.kind === 'right') {
      return { from: current.from, to: Math.max(Math.min(current.to + delta, now), current.from + minMs) };
    }
    const moved = Math.min(delta, Date.now() - current.to);
    return { from: current.from + moved, to: current.to + moved };
  };

  const box = drag && pointerX !== null ? boxAt(drag, pointerX) : { from: viewFrom, to: viewTo };
  const boxLeft = Math.max(left, x(box.from));
  const boxRight = Math.min(left + bandWidth, x(box.to));

  /** What a press at `offsetX` does. A narrow box moves from inside, so it is easy to grab. */
  const kindAt = (offsetX: number): DragKind | 'jump' => {
    const inside = offsetX >= boxLeft && offsetX <= boxRight;
    if (boxRight - boxLeft < 3 * EDGE_PX && inside) return 'move';
    if (Math.abs(offsetX - boxLeft) <= EDGE_PX) return 'left';
    if (Math.abs(offsetX - boxRight) <= EDGE_PX) return 'right';
    return inside ? 'move' : 'jump';
  };

  const offsetXOf = (event: PointerEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;

  const startDrag = (event: PointerEvent<SVGSVGElement>) => {
    const offsetX = offsetXOf(event);
    if (event.button !== 0 || offsetX < left - EDGE_PX || offsetX > left + bandWidth + EDGE_PX) return;
    const kind = kindAt(offsetX);
    let start = { from: viewFrom, to: viewTo };
    if (kind === 'jump') {
      // The box goes to the press, with its middle there
      const moved = Math.min(startTime + (offsetX - left) * msPerPx - (viewFrom + viewTo) / 2, Date.now() - viewTo);
      start = { from: viewFrom + moved, to: viewTo + moved };
    }
    setDrag({ kind: kind === 'jump' ? 'move' : kind, startX: offsetX, ...start, jumped: kind === 'jump' });
    setPointerX(offsetX);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    setDrag(null);
    const shown = boxAt(drag, offsetXOf(event));
    // A move under one pixel is a click on the box, which changes nothing
    const changed = (ms: number) => Math.abs(ms) >= msPerPx;
    if (drag.kind === 'move') {
      const moved = shown.from - viewFrom;
      if (drag.jumped ? moved !== 0 : changed(moved)) onMove(moved);
    } else if (changed(shown.from - viewFrom) || changed(shown.to - viewTo)) {
      onZoom(shown.from, shown.to);
    }
  };

  const hoverKind = drag ? drag.kind : pointerX === null ? null : kindAt(pointerX);
  const cursor = hoverKind === 'left' || hoverKind === 'right'
    ? 'cursor-ew-resize'
    : hoverKind === 'move' ? (drag ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer';

  return (
    <svg
      width={width}
      height={SVG_HEIGHT}
      role="img"
      aria-label={`Overview ${live ? `of the last ${overview.words}` : viewText(overview, now)}. The box shows the time in the chart. Drag the box to move in time. Drag an edge of the box to zoom.`}
      onPointerDown={startDrag}
      onPointerMove={event => setPointerX(offsetXOf(event))}
      onPointerUp={endDrag}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => { if (!drag) setPointerX(null); }}
      className={cn('block touch-none', cursor)}
    >
      <rect x={left} width={bandWidth} height={BAND_HEIGHT} rx={3} className="fill-zinc-800" />
      <StateBand segments={segments} startTime={startTime} rangeMs={overview.ms} left={left} width={bandWidth} y={0} height={BAND_HEIGHT} />
      {/* The time outside the box is dim, so the box stands out */}
      <rect x={left} width={Math.max(0, boxLeft - left)} height={BAND_HEIGHT} className="fill-zinc-950/65" />
      <rect x={boxRight} width={Math.max(0, left + bandWidth - boxRight)} height={BAND_HEIGHT} className="fill-zinc-950/65" />
      {boxRight > boxLeft && (
        <g className="pointer-events-none">
          <rect x={boxLeft} y={0.75} width={boxRight - boxLeft} height={BAND_HEIGHT - 1.5} rx={2} fill="none" strokeWidth={1.5} className="stroke-zinc-50" />
          <rect x={boxLeft - 1.5} y={3} width={3} height={BAND_HEIGHT - 6} rx={1} className="fill-zinc-50" />
          <rect x={boxRight - 1.5} y={3} width={3} height={BAND_HEIGHT - 6} rx={1} className="fill-zinc-50" />
        </g>
      )}
      <TimeLabels labels={timeLabels(overview.ms, now, live)} x={x} y={BAND_HEIGHT + TIME_LABEL_GAP} />
    </svg>
  );
}
