import { cn } from '@toolpath/ui';
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/ui/icons';
import type { CSSProperties, ReactNode } from 'react';
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

interface PanButtonsProps {
  /** False for the live chart: it already ends now */
  canGoLater: boolean;
  onEarlier: () => void;
  onLater: () => void;
  onNow: () => void;
}

/** Buttons that move the time of the chart: back, on, and back to now */
export function PanButtons({ canGoLater, onEarlier, onLater, onNow }: PanButtonsProps) {
  return (
    <div role="group" aria-label="Move in time" className="inline-flex gap-0.5 rounded-lg bg-zinc-950 p-[0.1875rem]">
      <button type="button" onClick={onEarlier} className={PAN_BUTTON_CLASS} aria-label="Earlier">
        <ChevronLeftIcon size={16} />
      </button>
      <button type="button" onClick={onLater} disabled={!canGoLater} className={PAN_BUTTON_CLASS} aria-label="Later">
        <ChevronRightIcon size={16} />
      </button>
      <button type="button" onClick={onNow} disabled={!canGoLater} className={PAN_BUTTON_CLASS}>
        Now
      </button>
    </div>
  );
}
