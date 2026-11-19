/**
 * The machine values that have a history. GET /api/machine/:id/history/:value takes one of these.
 * A number (such as spindle-speed, or spindle-load in percent) is the average in each window.
 * A state (connected, running, alarm, emergency) is 1 or 0, so its average is the part of the window that it was on.
 */
export const HISTORY_VALUES = [
  'spindle-speed',
  'spindle-load',
  'feedrate',
  'part-count',
  'part-goal',
  'tool-number',
  'connected',
  'running',
  'alarm',
  'emergency',
] as const;

export type HistoryValue = typeof HISTORY_VALUES[number];

/**
 * The machine states that are saved as periods (a value with a start and an end), for
 * GET /api/machine/:id/periods. They are text, so they are not in the number history.
 */
export const STATE_PERIOD_KINDS = ['program', 'alarm', 'mode', 'run-state', 'tool'] as const;

export type StatePeriodKind = typeof STATE_PERIOD_KINDS[number];

/** The values whose history is the last value in each window, not the average: a counter, or a number with no middle */
const LAST_VALUE_HISTORY: readonly HistoryValue[] = ['part-count', 'part-goal', 'tool-number'];

/**
 * How one window of the history gets its one value.
 * 'average' for a measured value and for a 1-or-0 state, 'last' for a counter or a tool number (T7.4 means nothing).
 */
export function historyWindowValue(value: HistoryValue): 'average' | 'last' {
  return LAST_VALUE_HISTORY.includes(value) ? 'last' : 'average';
}

/** The machine states in the state timeline. Offline also covers a time when ChatterBox did not run. */
export const TIMELINE_STATES = ['running', 'idle', 'alarm', 'offline'] as const;

export type TimelineState = typeof TIMELINE_STATES[number];
