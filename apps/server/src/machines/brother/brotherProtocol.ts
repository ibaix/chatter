/**
 * The Brother LOD protocol, with no connection: the request frames, the reply parser, the values of the machine state,
 * and the tool table from the replies of a tool read. Each function here is pure.
 */
import type {
  BrotherMachineData,
  DataItem,
  DataItemTransform,
  DataItemType,
  ParsedResponse,
  ToolTable,
} from '../../types/index.js';

const PANEL_MODES = ['MANUAL', 'MDI', 'MEMORY', 'EDIT'];

/** The two-digit start of an ALARM E01 value, and the letters that Brother shows for it */
const ALARM_PREFIXES: Record<string, string> = {
  '01': 'EX', '02': 'EC', '03': 'SV', '04': 'NC', '05': 'IO', '06': 'SP',
  '07': 'SM', '08': 'SL', '09': 'CM', '10': 'ES', '11': 'FC', '90': 'OM',
};
/** CM is a communication message and OM means no alarm, so neither is a machine alarm */
const NOT_ALARMS = ['CM', 'OM'];

/** MEM A01 "operation status", in MTConnect execution words */
const OPERATION_STATUS_EXECUTION: Record<string, string> = {
  '0': 'READY', '1': 'ACTIVE', '2': 'FEED_HOLD', '3': 'INTERRUPTED',
};

/** Transforms for values that need more than a type conversion */
export const TRANSFORMS: Record<string, DataItemTransform> = {
  mode: (val) => {
    const index = Math.floor(parseFloat(String(val)));
    return PANEL_MODES[index] ?? index;
  },

  alarm: (val) => {
    const prefix = ALARM_PREFIXES[String(val).trim().substring(0, 2)];
    return prefix !== undefined && !NOT_ALARMS.includes(prefix);
  },

  // From open-source schemas that cite the Brother manual (C00 5.6.4.8, D00 3.6.5.8). Not tested on a real machine yet.
  execution: (val) => OPERATION_STATUS_EXECUTION[String(val).trim()] ?? '',

  alarmCode: (val) => {
    const trimmed = String(val).trim();
    const prefix = ALARM_PREFIXES[trimmed.substring(0, 2)];
    if (prefix === 'OM') return '';
    return prefix ? prefix + trimmed.substring(2) : trimmed;
  },
};

// Data item definitions: [label, command, key, index, type, transform?]
// Labels use normalized camelCase field names matching MachineData interface
export const DATA_ITEMS: DataItem[] = [
  ['mode',         'PANEL',  'K01', 0, 'string', TRANSFORMS.mode],
  ['program',      'MEM',    'A01', 1, 'string'],
  ['execution',    'MEM',    'A01', 2, 'string', TRANSFORMS.execution],
  ['partCount',    'WKCNTR', 'A01', 1, 'int'],
  ['partGoal',     'WKCNTR', 'A01', 2, 'int'],
  ['toolNumber',   'PDSP',   'X01', 3, 'int'],
  ['spindleSpeed', 'PDSP',   'X01', 1, 'int'],
];

/** The command for the alarm list. Its E01 line has one slot for each alarm or message. */
export const ALARM_COMMAND = 'ALARM';

/** The data item of a macro variable: its value is in the C<location> line of the macro reply */
export function macroDataItem(label: string, macroCommand: string, location: number): DataItem {
  return [label, macroCommand, 'C' + location, 0, 'float'];
}

/** The commands of one read of the machine state, each one time: the commands of the data items, and the alarm list */
export function stateCommandsOf(dataItems: DataItem[]): string[] {
  return [...new Set([...dataItems.map(([, command]) => command), ALARM_COMMAND])];
}

/**
 * The alarm and its code, from all the slots of the E01 alarm list. A slot can hold a communication message (CM)
 * or "no alarm" (OM). A Speedio puts a CM entry in the list when it gets a command that it does not know, so a
 * real alarm can be in a later slot. The alarm code is the code of the first real alarm.
 */
export function alarmOfList(slots: string[]): { alarm: boolean; alarmCode: string } {
  const firstAlarm = slots.map(slot => withoutQuotes(slot)).find(slot => slot !== '' && TRANSFORMS.alarm(slot) === true);
  return firstAlarm === undefined
    ? { alarm: false, alarmCode: '' }
    : { alarm: true, alarmCode: String(TRANSFORMS.alarmCode(firstAlarm)) };
}

/**
 * The values of the machine state from the replies of one read, by the label of each data item. A value that is not
 * in the replies is not in the result, so the last value stays.
 */
export function machineValuesOf(responses: Record<string, ParsedResponse>, dataItems: DataItem[]): BrotherMachineData {
  const values: BrotherMachineData = {};
  for (const [label, command, key, index, type, transform] of dataItems) {
    const raw = responses[command]?.[key]?.[index];
    if (raw !== undefined) {
      values[label] = parseValue(raw, type, transform);
    }
  }
  const alarmSlots = responses[ALARM_COMMAND]?.E01;
  if (alarmSlots) Object.assign(values, alarmOfList(alarmSlots));
  return values;
}

/** The value of each type when the machine sends nothing */
const EMPTY_VALUES: Record<DataItemType, string | number | boolean> = {
  int: 0,
  float: 0,
  bool: false,
  string: '',
};

/** Brother puts text values in single quotes */
function withoutQuotes(text: string): string {
  return text.trim().replace(/^'|'$/g, '').trim();
}

/** Convert a raw value to the given type, after the transform when there is one */
export function parseValue(
  raw: string | undefined,
  type: DataItemType,
  transform?: DataItemTransform
): string | number | boolean {
  let val: string | number | boolean = typeof raw === 'string' ? withoutQuotes(raw) : (raw ?? '');
  if (transform) val = transform(val);

  if (val === '' || val === null || val === undefined) {
    return EMPTY_VALUES[type] ?? '';
  }

  switch (type) {
    case 'int': return Math.floor(parseFloat(String(val)));
    case 'float': return parseFloat(String(val));
    case 'bool': return Boolean(val);
    default: return String(val);
  }
}

/** A Brother request: "%CLOD    <command>  ", then a checksum, between % signs */
export function brotherCommand(command: string): string {
  const cmdBody = 'CLOD'.padEnd(8) + command.padEnd(8) + '  \r\n';
  const checksum = [...cmdBody].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 16;
  return `%${cmdBody}\r\n${String(checksum).padStart(2, '0')}%\r\n`;
}

/** The key of the reply status in a parsed reply. No data key of a Brother starts with @. */
export const REPLY_STATUS_KEY = '@status';
/** The header line of a reply: "RLOD", the command, and a status of 2 digits */
const REPLY_HEADER = /^RLOD\s+\S+?\s*(\d{2})$/;

/**
 * Each reply line is "KEY,value,value,..."; lines with no comma are headers. The status of the header line
 * "RLOD    <command>  00" is under REPLY_STATUS_KEY: 00 is good, another value (for example 08) means that the
 * control does not know the command.
 */
export function parseResponse(response: string): ParsedResponse {
  const result: ParsedResponse = {};
  for (const line of response.split('\r\n')) {
    const parts = line.split(',');
    if (parts.length > 1) {
      result[parts[0]] = parts.slice(1).map(s => s.trim());
    }
    const status = REPLY_HEADER.exec(line)?.[1];
    if (status !== undefined) result[REPLY_STATUS_KEY] = [status];
  }
  return result;
}

export type ControlType = 'C00' | 'D00';
export type AtcCommand = 'ATCTL' | 'ATCTLD';

/** Each control type has its own command for the tool in each ATC pot. Chatter tries them in this order. */
export const ATC_COMMANDS: Array<{ command: AtcCommand; controlType: ControlType }> = [
  { command: 'ATCTL', controlType: 'C00' },
  { command: 'ATCTLD', controlType: 'D00' },
];

/**
 * The control knows the ATC command: the reply status is 00, also with no pots (an empty magazine).
 * A reply with no status line counts as known only when it has pots (M## keys).
 */
export function isKnownAtcReply(response: ParsedResponse): boolean {
  const status = response[REPLY_STATUS_KEY]?.[0];
  if (status !== undefined) return status === '00';
  return Object.keys(response).some(key => /^M\d{2}$/.test(key));
}

/** The ATC reply has the keys M02 to M51, for pots 1 to 50 */
const FIRST_POT_KEY = 2;
const LAST_POT_KEY = 51;
const MAX_TOOL_NUMBER = 99;

/** The position of each value in a row of the tool data reply */
const TOOL_DATA_COLUMN = { length: 0, lengthWear: 1, diameter: 2, diameterWear: 3, name: 8 } as const;

/** The offsets and the name of one tool */
export type ToolOffsets = Omit<ToolTable[number], 'toolNum'>;

/** The tool in each pot, from the ATC reply */
export function potToolsOf(atcResponse: ParsedResponse): Record<number, number> {
  const potTools: Record<number, number> = {};
  for (let potKey = FIRST_POT_KEY; potKey <= LAST_POT_KEY; potKey++) {
    const rawValue = atcResponse[`M${String(potKey).padStart(2, '0')}`]?.[0];
    const toolNum = parseInt(rawValue, 10);
    if (toolNum >= 1 && toolNum <= MAX_TOOL_NUMBER) {
      potTools[potKey - 1] = toolNum;
    }
  }
  return potTools;
}

/** The offsets and the name of each tool, from the tool data reply */
export function toolOffsetsOf(toolDataResponse: ParsedResponse): Map<number, ToolOffsets> {
  // Some controls send 3-digit keys (T001), others 2-digit keys (T01)
  const keyDigits = toolDataResponse['T001'] !== undefined ? 3 : 2;

  const toolOffsets = new Map<number, ToolOffsets>();
  for (let toolNum = 1; toolNum <= MAX_TOOL_NUMBER; toolNum++) {
    const values = toolDataResponse[`T${String(toolNum).padStart(keyDigits, '0')}`];
    if (!values) continue;
    toolOffsets.set(toolNum, {
      length: parseFloat(values[TOOL_DATA_COLUMN.length]) || 0,
      lengthWear: parseFloat(values[TOOL_DATA_COLUMN.lengthWear]) || 0,
      diameter: parseFloat(values[TOOL_DATA_COLUMN.diameter]) || 0,
      diameterWear: parseFloat(values[TOOL_DATA_COLUMN.diameterWear]) || 0,
      name: withoutQuotes(values[TOOL_DATA_COLUMN.name] || ''),
    });
  }
  return toolOffsets;
}

/** The tool table: the tool in each pot, with its offsets and name. With no pots, the table is empty. */
export function toolTableOf(potTools: Record<number, number>, toolOffsets: Map<number, ToolOffsets>): ToolTable {
  const toolTable: ToolTable = {};
  for (const [pot, toolNum] of Object.entries(potTools)) {
    toolTable[Number(pot)] = { toolNum, ...toolOffsets.get(toolNum) };
  }
  return toolTable;
}
