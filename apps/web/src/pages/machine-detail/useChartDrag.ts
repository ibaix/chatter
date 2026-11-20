import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { MIN_DRAG_PX } from './historyChart';

/** One step of a sideways scroll moves the time by a quarter of the range */
const WHEEL_STEP = 0.25;
/** How far a sideways scroll goes, in pixels, before the time moves one step */
const WHEEL_STEP_PX = 60;

interface ChartDragOptions {
  /** The time that the chart shows */
  rangeMs: number;
  /** The end of the chart, or null for the live chart that ends now */
  end: number | null;
  /** The chart clock (useChartClock): the end of the live chart */
  now: number;
  /** The space left and right of the plot in the chart body, in pixels */
  margins: number;
  /** Moves the time of the chart by `deltaMs`: negative goes back */
  onMove: (deltaMs: number) => void;
}

/**
 * A drag or a sideways scroll on the chart body moves the time.
 * While the user drags, `shiftMs` tells how far the time moves, so the chart can draw the data that it loaded around
 * its time (loadSpan). The new time loads once, when the drag ends.
 */
export function useChartDrag({ rangeMs, end, now, margins, onMove }: ChartDragOptions) {
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Where a drag started, and the width of the plot then. State, so the cursor changes at once. */
  const [dragStart, setDragStart] = useState<{ x: number; plotWidth: number } | null>(null);
  /** How far a drag moves the time, in milliseconds: negative goes back */
  const [shiftMs, setShiftMs] = useState(0);
  const wheelDelta = useRef(0);

  /** The time that a drag of `x` pixels moves. A drag to the right goes back. A drag cannot go after now. */
  const dragMs = (x: number, plotWidth: number) => Math.min((-x / plotWidth) * rangeMs, end === null ? 0 : now - end);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    setDragStart({ x: event.clientX, plotWidth: event.currentTarget.getBoundingClientRect().width - margins });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart && dragStart.plotWidth > 0) setShiftMs(dragMs(event.clientX - dragStart.x, dragStart.plotWidth));
  };
  /** The browser took the pointer, for example to scroll the page. The time does not move. */
  const onPointerCancel = () => {
    setDragStart(null);
    setShiftMs(0);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = dragStart;
    setDragStart(null);
    setShiftMs(0);
    if (!start || start.plotWidth <= 0) return;
    // A small move is a click, for example to see a hover box
    if (Math.abs(event.clientX - start.x) < MIN_DRAG_PX) return;
    const moved = dragMs(event.clientX - start.x, start.plotWidth);
    if (moved !== 0) onMove(moved);
  };

  /**
   * A sideways scroll (trackpad, or Shift and the mouse wheel) moves the time. An up or down scroll stays with the page.
   * The chart stops a sideways scroll, so the browser does not go back a page on a swipe.
   */
  const scrollTime = (event: WheelEvent) => {
    const sideways = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    if (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    wheelDelta.current += sideways;
    if (Math.abs(wheelDelta.current) < WHEEL_STEP_PX) return;
    onMove(Math.sign(wheelDelta.current) * WHEEL_STEP * rangeMs);
    wheelDelta.current = 0;
  };
  // The listener stays the same, and calls the newest handler, which knows the newest range and end
  const scrollHandler = useRef(scrollTime);
  useLayoutEffect(() => { scrollHandler.current = scrollTime; });
  // React listens to the wheel passively, so its handler cannot stop the scroll
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const listener = (event: WheelEvent) => scrollHandler.current(event);
    body.addEventListener('wheel', listener, { passive: false });
    return () => body.removeEventListener('wheel', listener);
  }, []);

  return {
    bodyRef,
    shiftMs,
    dragging: dragStart !== null,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
