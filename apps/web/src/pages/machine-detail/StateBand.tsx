import { TIMELINE_STATES, type TimelineState } from '@local-chatter/shared';
import { cn } from '@toolpath/ui';
import { memo, useId } from 'react';
import { STATE_FILL_COLORS } from '../../components/MachineStateMark';
import { STATE_LABELS } from '../../machines/machineStatus';
import { timeScale } from './historyChart';
import type { StateSegment } from './stateTimeline';

const STATE_FILLS: Record<Exclude<TimelineState, 'offline'>, string> = {
  running: 'fill-running',
  idle: 'fill-idle',
  alarm: 'fill-alarm',
};

/** A short alarm is still drawn at least this wide, so it does not vanish in a 7-day band */
const MIN_SEGMENT_WIDTH = 1;

interface StateBandProps {
  segments: StateSegment[];
  /** The time at the left edge of the band */
  startTime: number;
  rangeMs: number;
  /** The x position and the width of the band in the <svg> */
  left: number;
  width: number;
  y: number;
  height: number;
}

/**
 * The machine state as colored blocks along the time axis, inside an <svg>.
 * Offline has stripes, so it is not told apart by color only.
 * It takes plain numbers, not a function, so memo can skip the redraw when only the hover moves:
 * a 7-day band can have thousands of blocks.
 * A chart loads more time than it shows, so the band draws only the part of each segment between `left` and `left + width`.
 */
export const StateBand = memo(function StateBand({ segments, startTime, rangeMs, left, width, y, height }: StateBandProps) {
  const stripesId = useId();
  const { x } = timeScale(startTime, rangeMs, left, width);
  const right = left + width;
  return (
    <g aria-hidden="true">
      <defs>
        <OfflineStripes id={stripesId} />
      </defs>
      {segments.map((segment, index) => {
        const from = Math.max(left, x(segment.start));
        const to = Math.min(right, x(segment.end));
        if (to < left || from > right) return null;
        return (
          <rect
            key={`${segment.start}-${segment.state}-${index}`}
            x={Math.min(from, right - MIN_SEGMENT_WIDTH)}
            y={y}
            width={Math.max(MIN_SEGMENT_WIDTH, to - from)}
            height={height}
            fill={segment.state === 'offline' ? `url(#${stripesId})` : undefined}
            className={segment.state === 'offline' ? undefined : STATE_FILLS[segment.state]}
          />
        );
      })}
    </g>
  );
});

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
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-sm', STATE_FILL_COLORS[state], className)} />;
}

/** What each state means, for the legend of the full state chart */
const STATE_MEANINGS: Record<TimelineState, string> = {
  running: 'Running: a program runs',
  idle: 'Idle: connected, no program runs',
  alarm: 'Alarm: shows over Running',
  offline: 'Offline: no answer, or Chatter was off',
};

/** The states and their colors in words. `explain` adds what each state means. */
export function StateLegend({ explain = false, className }: { explain?: boolean; className?: string }) {
  return (
    <ul aria-label="Machine state" className={cn('m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-zinc-300', className)}>
      {TIMELINE_STATES.map(state => (
        <li key={state} className="inline-flex items-center gap-1.5">
          <StateSwatch state={state} />
          {explain ? STATE_MEANINGS[state] : STATE_LABELS[state]}
        </li>
      ))}
    </ul>
  );
}
