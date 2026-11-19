import { cn } from '@toolpath/ui';
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
