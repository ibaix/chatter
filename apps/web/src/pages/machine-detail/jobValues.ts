import type { HistoryValue } from '@local-chatter/shared';
import type { ChartChoiceId } from './chartValues';
import { isReachable, machineStateOf, NO_VALUE, partCountOf, spindleLoadOf, spindleSpeedText, toolText } from '../../machines/machineStatus';
import type { Machine, MachineData, MachinePath, MachineSpindle } from '../../types';

/** The rows of a machine that is not connected, each with a dash */
const OFFLINE_ROWS: Omit<JobValue, 'value'>[] = [
  { label: 'Mode' },
  { label: 'Program' },
  { label: 'Parts', chartValue: 'part-count' },
  { label: 'Spindle', chartValue: 'spindle-speed' },
  { label: 'Tool' },
];

export interface JobValue {
  label: string;
  value: string;
  /** From 0 to 1: shows a bar under the value */
  fraction?: number | null;
  /** The chart value that this row also shows. The row hides while the chart shows that value, so it is not on the page twice. */
  chartValue?: HistoryValue;
}

/**
 * The macro variables the user asked to watch. The connector stores each one by name, or by location.
 * On a Siemens control they are R parameters.
 */
function macroValues(machine: Machine, data: MachineData): JobValue[] {
  const unnamedLabel = machine.type === 'siemens' ? 'R' : 'Macro ';
  return (machine.macros ?? []).map(macro => {
    const value = data[macro.name || `macro_${macro.location}`];
    return {
      label: macro.name || `${unnamedLabel}${macro.location}`,
      value: value !== undefined && value !== null ? String(value) : NO_VALUE,
    };
  });
}

/** The spindle load row, only for a machine that sends it (a Brother or an analog spindle does not) */
function spindleLoadValues(data: MachineData): JobValue[] {
  const load = spindleLoadOf(data);
  return load ? [{ label: 'Spindle load', value: load.text, fraction: load.fraction, chartValue: 'spindle-load' }] : [];
}

/** "500 rpm · 3%", or a dash when the control sends neither */
function spindleText(spindle: MachineSpindle): string {
  const speed = spindleSpeedText({ spindleSpeed: spindle.speed });
  const load = spindleLoadOf({ spindleLoad: spindle.load });
  return [speed, load?.text].filter(Boolean).join(' · ') || NO_VALUE;
}

/**
 * A FANUC control with more than one path, such as a two-path lathe: the run state and program of each path,
 * and each spindle other than the one of the Spindle row (the first spindle of path 1), by its name.
 * The other rows are of the whole machine.
 */
function pathValues(paths: MachinePath[] | undefined): JobValue[] {
  if (!paths || paths.length < 2) return [];
  const pathRows = paths.map(path => ({
    label: `Path ${path.path}`,
    value: [path.runState, path.program].filter(Boolean).join(' · ') || NO_VALUE,
  }));
  const spindleRows = paths
    .flatMap((path, index) => (index === 0 ? path.spindles.slice(1) : path.spindles))
    .map(spindle => ({ label: `Spindle ${spindle.name}`, value: spindleText(spindle) }));
  return [...pathRows, ...spindleRows];
}

/** The full name of the main program, such as //DATA_SV/O6000, when a FANUC control with more than one path sends it */
function programText(machine: Machine): string | undefined {
  if (machine.type !== 'fanuc') return machine.data.program;
  return machine.data.paths?.[0]?.programPath || machine.data.program;
}

/** The SINUMERIK program state, tool name and feed override, when the control sends them */
function siemensValues(data: Extract<Machine, { type: 'siemens' }>['data']): JobValue[] {
  const values: JobValue[] = [];
  if (data.programStatus) values.push({ label: 'Program state', value: data.programStatus });
  if (data.toolName) values.push({ label: 'Tool name', value: data.toolName });
  if (typeof data.feedOverride === 'number') values.push({ label: 'Feed override', value: `${Math.round(data.feedOverride)}%` });
  return values;
}

/**
 * The values of the job on the machine, without the value that the chart shows (`chartValue`).
 * Each machine type sends a different set.
 */
export function jobValuesOf(machine: Machine, chartValue?: ChartChoiceId): JobValue[] {
  return allJobValuesOf(machine).filter(jobValue => !isInChart(jobValue, chartValue));
}

/** A row with no chart value (for example Mode) is never in the chart, also when no chart value is given */
function isInChart(jobValue: JobValue, chartValue: ChartChoiceId | undefined): boolean {
  return jobValue.chartValue !== undefined && jobValue.chartValue === chartValue;
}

/** Every row of the machine, with a dash in each row when the machine is not connected */
function allJobValuesOf(machine: Machine): JobValue[] {
  const { data } = machine;
  if (!isReachable(machineStateOf(machine))) {
    return OFFLINE_ROWS.map(row => ({ ...row, value: NO_VALUE }));
  }
  const parts = partCountOf(data);
  const values: JobValue[] = [
    { label: 'Mode', value: data.mode || NO_VALUE },
    ...(machine.type === 'mtconnect' ? [{ label: 'Execution', value: machine.data.execution || NO_VALUE }] : []),
    { label: 'Program', value: programText(machine) || NO_VALUE },
    { label: 'Parts', value: parts?.text ?? NO_VALUE, fraction: parts?.fraction, chartValue: 'part-count' },
    { label: 'Spindle', value: spindleSpeedText(data) ?? NO_VALUE, chartValue: 'spindle-speed' },
    ...spindleLoadValues(data),
    { label: 'Tool', value: toolText(data) ?? NO_VALUE },
    ...(machine.type === 'fanuc' ? pathValues(machine.data.paths) : []),
  ];
  if (machine.type === 'fanuc' && machine.data.operatorMessage) {
    values.push({ label: 'Operator message', value: machine.data.operatorMessage });
  }
  if (machine.type === 'fanuc' && machine.data.warning) {
    values.push({ label: 'Warning', value: machine.data.warning });
  }
  if (machine.type === 'siemens') values.push(...siemensValues(machine.data));
  return [...values, ...macroValues(machine, data)];
}
