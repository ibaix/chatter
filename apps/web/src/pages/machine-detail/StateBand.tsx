import type { TimelineState } from '@local-chatter/shared';
import { cn } from '@toolpath/ui';
import { useId } from 'react';
import type { StateSegment } from './stateTimeline';

export const TIMELINE_STATE_LABELS: Record<TimelineState, string> = {
  running: 'Running',
  idle: 'Idle',
  alarm: 'Alarm',
  offline: 'Offline',
};

const STATE_FILLS: Record<Exclude<TimelineState, 'offline'>, string> = {
  running: 'fill-running',
  idle: 'fill-idle',
  alarm: 'fill-alarm',
};

/** Full class names, so Tailwind finds them */
const SWATCH_COLORS: Record<Exclude<TimelineState, 'offline'>, string> = {
  running: 'bg-running',
  idle: 'bg-idle',
  alarm: 'bg-alarm',
};

/** A short alarm is still drawn at least this wide, so it does not vanish in a 7-day band */
const MIN_SEGMENT_WIDTH = 1;

interface StateBandProps {
  segments: StateSegment[];
  /** The x position of a time */
  x: (time: number) => number;
  y: number;
  height: number;
}

/**
 * The machine state as colored blocks along the time axis, inside an <svg>.
 * Offline has stripes, so it is not told apart by color only.
 */
export function StateBand({ segments, x, y, height }: StateBandProps) {
  const stripesId = useId();
  return (
    <g aria-hidden="true">
      <defs>
        <OfflineStripes id={stripesId} />
      </defs>
      {segments.map(segment => (
        <rect
          key={segment.start}
          x={x(segment.start)}
          y={y}
          width={Math.max(MIN_SEGMENT_WIDTH, x(segment.end) - x(segment.start))}
          height={height}
          fill={segment.state === 'offline' ? `url(#${stripesId})` : undefined}
          className={segment.state === 'offline' ? undefined : STATE_FILLS[segment.state]}
        />
      ))}
    </g>
  );
}

function OfflineStripes({ id }: { id: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={6} height={6} className="fill-zinc-800" />
      <line x1={0} x2={0} y1={0} y2={6} strokeWidth={4} className="stroke-offline" />
    </pattern>
  );
}

/** A small square of the state's color, for the legend and the hover box */
export function StateSwatch({ state, className }: { state: TimelineState; className?: string }) {
  if (state === 'offline') {
    return (
      <span
        aria-hidden="true"
        className={cn('size-2.5 shrink-0 rounded-sm', className)}
        style={{ background: 'repeating-linear-gradient(45deg, var(--color-offline) 0 2px, var(--color-zinc-800) 2px 5px)' }}
      />
    );
  }
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm', SWATCH_COLORS[state], className)} />;
}
