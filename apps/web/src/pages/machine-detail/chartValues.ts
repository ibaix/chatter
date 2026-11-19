import type { HistoryValue } from '@local-chatter/shared';
import type { Machine } from '../../types';
import { formatChartNumber } from './historyChart';

/** A machine value that the history chart can show */
export interface ChartValue {
  id: HistoryValue;
  /** The name in the dropdown and in the messages, for example "Spindle speed" */
  name: string;
  /** The unit next to the name, for example "RPM". Not set when the value has no unit. */
  unit?: string;
  /** What the line shows, before "in the last 10 minutes" */
  description: string;
  /** The value axis goes at least this high, so a small value does not fill the chart */
  smallestAxisTop: number;
  /** The newest value from the live machine events, or undefined when the machine does not send it */
  liveValueOf: (machine: Machine) => number | undefined;
  /** The value with its unit, for the hover box and the screen reader text */
  format: (value: number) => string;
}

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

export const SPINDLE_SPEED: ChartValue = {
  id: 'spindle-speed',
  name: 'Spindle speed',
  unit: 'RPM',
  description: 'How fast the spindle turned',
  smallestAxisTop: 100,
  liveValueOf: machine => numberOf(machine.data.spindleSpeed),
  format: value => `${formatChartNumber(value)} RPM`,
};

const SPINDLE_LOAD: ChartValue = {
  id: 'spindle-load',
  name: 'Spindle load',
  unit: '%',
  description: 'How hard the spindle worked',
  smallestAxisTop: 100,
  liveValueOf: machine => numberOf(machine.data.spindleLoad),
  format: value => `${formatChartNumber(value)}%`,
};

const FEEDRATE: ChartValue = {
  id: 'feedrate',
  name: 'Feedrate',
  // No unit: the control sends mm/min or in/min, and it does not tell which
  description: 'How fast the axes moved',
  smallestAxisTop: 100,
  liveValueOf: machine => numberOf(machine.data.feedrate),
  format: value => formatChartNumber(value),
};

const PART_COUNT: ChartValue = {
  id: 'part-count',
  name: 'Part count',
  description: 'The part counter of the machine',
  smallestAxisTop: 20,
  liveValueOf: machine => numberOf(machine.data.partCount),
  format: value => `${formatChartNumber(value)} parts`,
};

const TOOL_NUMBER: ChartValue = {
  id: 'tool-number',
  name: 'Tool number',
  description: 'The tool in the spindle',
  smallestAxisTop: 20,
  liveValueOf: machine => numberOf(machine.data.toolNumber),
  format: value => `T${Math.round(value)}`,
};

/** The machine state over time (running, idle, alarm, offline), as a colored band and not as a line */
export const MACHINE_STATE = {
  id: 'machine-state',
  name: 'Machine state',
  description: 'What the machine did',
} as const;

/** One choice in the chart menu: a machine value, or the machine state */
export type ChartChoice = ChartValue | typeof MACHINE_STATE;
export type ChartChoiceId = ChartChoice['id'];

/** The choice the user made, or the spindle speed when the machine does not send the chosen value now */
export function shownChartChoice(choices: ChartChoice[], chosenId: ChartChoiceId): ChartChoice {
  return choices.find(choice => choice.id === chosenId) ?? SPINDLE_SPEED;
}

/** The chart menu: the machine state first, then the values that the machine sends */
export function chartChoicesFor(machine: Machine): ChartChoice[] {
  return [MACHINE_STATE, ...chartValuesFor(machine)];
}

/**
 * The values the chart can show. Spindle speed is always first, because it is the chart's start value.
 * The others show only for a machine that sends them, so the dropdown has no empty charts.
 */
export function chartValuesFor(machine: Machine): ChartValue[] {
  const others = [SPINDLE_LOAD, FEEDRATE, PART_COUNT, TOOL_NUMBER].filter(value => value.liveValueOf(machine) !== undefined);
  return [SPINDLE_SPEED, ...others];
}
