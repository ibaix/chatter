import { cn } from '@toolpath/ui';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { RedoIcon, UndoIcon } from '../../components/ui/icons';
import { timeLabelAnchor, type TimeLabel } from './historyChart';

/** The text of the axis labels of both charts */
export const AXIS_LABEL_CLASS = 'fill-zinc-300 font-mono text-[0.6875rem]';

/** The time labels under a chart, inside an <svg>. The first and the last label stay inside the chart. */
export function TimeLabels({ labels, x, y }: { labels: TimeLabel[]; x: (time: number) => number; y: number }) {
  return (
    <>
      {labels.map(({ time, text }, index) => (
        <text key={index} x={x(time)} y={y} textAnchor={timeLabelAnchor(index, labels.length)} className={AXIS_LABEL_CLASS}>
          {text}
        </text>
      ))}
    </>
  );
}

/** The box of a hover readout, over the chart. `style` places it. */
export function ChartTooltip({ style, className, children }: { style: CSSProperties; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute flex flex-col gap-0.5 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs',
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

const PAN_BUTTON_CLASS =
  'inline-flex min-h-8 items-center gap-1 rounded-md border-0 bg-transparent px-2 font-semibold text-zinc-200 hover:text-zinc-50 disabled:cursor-default disabled:text-zinc-500';

interface ViewButtonsProps {
  canUndo: boolean;
  canRedo: boolean;
  /** False for the live chart: it already ends now */
  canGoToNow: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onNow: () => void;
}

/** Buttons that change the time of the chart: the previous view, the next view, and back to now */
export function ViewButtons({ canUndo, canRedo, canGoToNow, onUndo, onRedo, onNow }: ViewButtonsProps) {
  return (
    <div role="group" aria-label="Move in time" className="inline-flex gap-0.5 rounded-lg bg-zinc-950 p-[0.1875rem]">
      <HistoryButton label="Previous view" enabled={canUndo} onClick={onUndo}>
        <UndoIcon size={16} />
      </HistoryButton>
      <HistoryButton label="Next view" enabled={canRedo} onClick={onRedo}>
        <RedoIcon size={16} />
      </HistoryButton>
      <button type="button" onClick={onNow} disabled={!canGoToNow} className={PAN_BUTTON_CLASS}>
        Now
      </button>
    </div>
  );
}

interface HistoryButtonProps {
  label: string;
  enabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

/**
 * The previous view or the next view button. At the end of the history it is off with aria-disabled, not disabled:
 * the browser takes the focus away from a disabled button, and the next Tab then starts at the top of the page.
 */
function HistoryButton({ label, enabled, onClick, children }: HistoryButtonProps) {
  return (
    <button
      type="button"
      onClick={enabled ? onClick : undefined}
      aria-disabled={enabled ? undefined : true}
      className={cn(PAN_BUTTON_CLASS, !enabled && 'cursor-default text-zinc-500 hover:text-zinc-500')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/** The x position of the pointer from the left edge of the element that has the handler */
export function offsetXOf(event: PointerEvent<Element>): number {
  return event.clientX - event.currentTarget.getBoundingClientRect().left;
}

/** A time that the user highlights on the overview strip, to zoom in */
export interface ZoomSelection {
  from: number;
  to: number;
}

interface ZoomHighlightProps {
  selection: ZoomSelection | null;
  /** The x position of a time */
  x: (time: number) => number;
  /** The highlight stays between these x positions */
  left: number;
  right: number;
  height: number;
}

/** The highlighted time while the user drags on the overview strip, inside an <svg>. The strip and the chart both show it. */
export function ZoomHighlight({ selection, x, left, right, height }: ZoomHighlightProps) {
  if (!selection) return null;
  const from = Math.max(left, x(selection.from));
  const to = Math.min(right, x(selection.to));
  if (to <= from) return null;
  return (
    <rect data-zoom-highlight x={from} y={0} width={to - from} height={height} strokeWidth={1} className="pointer-events-none fill-zinc-50/15 stroke-zinc-50/60" />
  );
}
