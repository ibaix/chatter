import { cn } from '@toolpath/ui';
import { useState, type PointerEvent } from 'react';
import { CheckIcon, CloseIcon } from '../../components/ui/icons';
import { useBoxSize } from '../../hooks/useBoxSize';
import type { Machine } from '../../types';
import { offsetXOf, TimeLabels, ZoomHighlight, type ZoomSelection } from './ChartParts';
import { MIN_DRAG_PX, timeLabels, timeScale, viewText, type ChartRange } from './historyChart';
import { StateBand } from './StateBand';
import { liveStateOf, type StateSegment } from './stateTimeline';
import { useStateTimeline } from './useStateTimeline';

const BAND_HEIGHT = 16;
/** The space between the band and the time labels */
const TIME_LABEL_GAP = 15;
const SVG_HEIGHT = BAND_HEIGHT + TIME_LABEL_GAP + 3;
/** The row above the band for the zoom buttons. It is always there, so the chart does not jump. */
const ZOOM_ROW_HEIGHT = 22;
const ZOOM_BUTTON_SIZE = 20;
/** The space between the accept button and the clear button */
const ZOOM_BUTTON_GAP = 8;
const ZOOM_BUTTON_CLASS = 'absolute top-0 inline-flex items-center justify-center rounded-full border-0 bg-zinc-700 p-0 text-zinc-50';

interface ChartOverviewProps {
  machine: Machine;
  /** The range button that the user picked last. The strip shows this much time. */
  overview: ChartRange;
  /** The end of the strip, or null for a strip that ends now */
  overviewEnd: number | null;
  /** The chart clock (useChartClock): the end of a live strip */
  clockNow: number;
  /** The time in the chart, which the box shows */
  view: ChartRange;
  viewEnd: number | null;
  /** The time that the user highlights now, also shown on the chart */
  selection: ZoomSelection | null;
  onSelect: (selection: ZoomSelection | null) => void;
  /** The space left and right of the band, so the band lines up with the plot above it */
  left: number;
  right: number;
  /** Moves the time of the chart by `deltaMs`: negative goes back */
  onMove: (deltaMs: number) => void;
  /** Shows the time from `from` to `to` in the chart */
  onZoom: (from: number, to: number) => void;
  /** Shows the full time of the strip again. Undefined while the chart is not zoomed in. */
  onClearZoom?: () => void;
  /** Makes the zoom the full time of the strip. It shows only with `onClearZoom`. */
  onAcceptZoom?: () => void;
}

/**
 * A thin machine state band of the full range under the chart, with a box on the time that the chart shows.
 * Drag on the band to highlight a time and zoom in to it. Click the band to move the chart there.
 * While the chart is zoomed in, buttons above the box accept the zoom as the full range, or clear it.
 */
export function ChartOverview({ machine, overview, overviewEnd, ...plotProps }: ChartOverviewProps) {
  const { segments, now } = useStateTimeline(machine.id, liveStateOf(machine), overview, plotProps.clockNow, overviewEnd);
  const { ref, width } = useBoxSize<HTMLDivElement>();
  return (
    <div ref={ref}>
      {width > 0 && (
        <OverviewPlot segments={segments} overview={overview} live={overviewEnd === null} now={now} width={width} {...plotProps} />
      )}
    </div>
  );
}

interface OverviewPlotProps extends Omit<ChartOverviewProps, 'machine' | 'overviewEnd'> {
  segments: StateSegment[];
  live: boolean;
  now: number;
  width: number;
}

function OverviewPlot(props: OverviewPlotProps) {
  const { segments, overview, live, now, clockNow, width, view, viewEnd, selection, onSelect, left, right, onMove, onZoom, onClearZoom, onAcceptZoom } = props;
  /** Where the pointer went down, or null when the user does not drag */
  const [startX, setStartX] = useState<number | null>(null);
  const bandRight = width - right;
  const startTime = now - overview.ms;
  const msPerPx = overview.ms / (bandRight - left);
  const scale = timeScale(startTime, overview.ms, left, bandRight - left);
  const { x } = scale;
  /** The time at an x position. A position outside the band is its edge. */
  const timeAt = (offsetX: number) => scale.timeAt(Math.min(Math.max(offsetX, left), bandRight));
  const viewTo = viewEnd ?? clockNow;
  const viewFrom = viewTo - view.ms;
  /** The x position of a time, inside the band */
  const bandX = (time: number) => Math.min(Math.max(x(time), left), bandRight);
  const boxLeft = bandX(viewFrom);
  const boxRight = bandX(viewTo);

  const selectionTo = (start: number, offsetX: number): ZoomSelection | null => {
    if (Math.abs(offsetX - start) < MIN_DRAG_PX) return null;
    const [from, to] = [timeAt(start), timeAt(offsetX)].sort((a, b) => a - b);
    return { from, to };
  };

  const startDrag = (event: PointerEvent<SVGSVGElement>) => {
    const offsetX = offsetXOf(event);
    if (event.button !== 0 || offsetX < left || offsetX > bandRight) return;
    setStartX(offsetX);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const followDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (startX !== null) onSelect(selectionTo(startX, offsetXOf(event)));
  };
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (startX === null) return;
    setStartX(null);
    onSelect(null);
    const offsetX = offsetXOf(event);
    const highlighted = selectionTo(startX, offsetX);
    if (highlighted) {
      onZoom(highlighted.from, highlighted.to);
      return;
    }
    // A click moves the chart, so the middle of its time is at the click. The chart cannot go after now.
    const moved = Math.min(timeAt(offsetX) - (viewFrom + viewTo) / 2, clockNow - viewTo);
    if (Math.abs(moved) >= msPerPx) onMove(moved);
  };
  const cancelDrag = () => {
    setStartX(null);
    onSelect(null);
  };

  // The buttons are over the middle of the box, and stay inside the strip
  const showAccept = onClearZoom !== undefined && onAcceptZoom !== undefined;
  const buttonsWidth = showAccept ? 2 * ZOOM_BUTTON_SIZE + ZOOM_BUTTON_GAP : ZOOM_BUTTON_SIZE;
  const buttonsLeft = Math.min(Math.max((boxLeft + boxRight - buttonsWidth) / 2, 0), width - buttonsWidth);
  const clearLeft = buttonsLeft + buttonsWidth - ZOOM_BUTTON_SIZE;
  const buttonSize = { width: ZOOM_BUTTON_SIZE, height: ZOOM_BUTTON_SIZE };

  return (
    <div className="relative" style={{ paddingTop: ZOOM_ROW_HEIGHT }}>
      {showAccept && (
        <button
          type="button"
          aria-label="Use as full range"
          title="Use as full range"
          onClick={onAcceptZoom}
          className={cn(ZOOM_BUTTON_CLASS, 'hover:bg-primary hover:text-on-primary')}
          style={{ left: buttonsLeft, ...buttonSize }}
        >
          <CheckIcon size={13} />
        </button>
      )}
      {onClearZoom && (
        <button
          type="button"
          aria-label="Clear the zoom"
          title="Clear the zoom"
          onClick={onClearZoom}
          className={cn(ZOOM_BUTTON_CLASS, 'hover:bg-zinc-500')}
          style={{ left: clearLeft, ...buttonSize }}
        >
          <CloseIcon size={12} />
        </button>
      )}
      <svg
        width={width}
        height={SVG_HEIGHT}
        role="img"
        aria-label={`Overview ${live ? `of the last ${overview.words}` : viewText(overview, now)}. The box shows the time in the chart. Drag on the overview to zoom in. Click it to move the chart there.`}
        onPointerDown={startDrag}
        onPointerMove={followDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        className="block cursor-crosshair touch-none"
      >
        <rect x={left} width={bandRight - left} height={BAND_HEIGHT} rx={3} className="fill-zinc-800" />
        <StateBand segments={segments} startTime={startTime} rangeMs={overview.ms} left={left} width={bandRight - left} y={0} height={BAND_HEIGHT} />
        {/* The time outside the box is dim, so the time in the chart stands out */}
        <rect x={left} width={Math.max(0, boxLeft - left)} height={BAND_HEIGHT} className="fill-zinc-950/65" />
        <rect x={boxRight} width={Math.max(0, bandRight - boxRight)} height={BAND_HEIGHT} className="fill-zinc-950/65" />
        {boxRight > boxLeft && (
          <rect
            x={boxLeft}
            y={0.75}
            width={boxRight - boxLeft}
            height={BAND_HEIGHT - 1.5}
            rx={2}
            fill="none"
            strokeWidth={1.5}
            className="pointer-events-none stroke-zinc-50"
          />
        )}
        <ZoomHighlight selection={selection} x={x} left={left} right={bandRight} height={BAND_HEIGHT} />
        <TimeLabels labels={timeLabels(overview.ms, now, live)} x={x} y={BAND_HEIGHT + TIME_LABEL_GAP} />
      </svg>
    </div>
  );
}
