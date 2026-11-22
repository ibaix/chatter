import { describe, it, expect } from 'vitest';
import {
  DATA_ITEMS,
  REPLY_STATUS_KEY,
  TRANSFORMS,
  alarmOfList,
  brotherCommand,
  isKnownAtcReply,
  machineValuesOf,
  macroDataItem,
  parseResponse,
  parseValue,
  potToolsOf,
  stateCommandsOf,
  toolOffsetsOf,
  toolTableOf,
} from './brotherProtocol.js';
import type { DataItemTransform } from '../../types/index.js';
import { MOCK_RESPONSES } from './testSupport.js';

describe('brotherCommand', () => {
  it('should build a properly formatted CLOD command', () => {
    const cmd = brotherCommand('PANEL');

    expect(cmd.startsWith('%')).toBe(true);
    expect(cmd).toContain('CLOD');
    expect(cmd).toContain('PANEL');
    expect(cmd).toMatch(/\d{2}%\r\n$/);
  });

  it('should pad command names to 8 characters', () => {
    expect(brotherCommand('MEM')).toContain('MEM     ');
  });

  it('should calculate consistent checksum', () => {
    expect(brotherCommand('PANEL')).toBe(brotherCommand('PANEL'));
    expect(brotherCommand('ALARM')).toBe(brotherCommand('ALARM'));
  });
});

describe('parseResponse', () => {
  it('should parse PANEL response correctly', () => {
    const response = parseResponse(MOCK_RESPONSES['PANEL']);
    expect(response['K01']).toBeDefined();
    expect(response['K01'][0]).toBe('0');
  });

  it('should parse MEM response correctly', () => {
    const response = parseResponse(MOCK_RESPONSES['MEM']);
    expect(response['A01']).toBeDefined();
    expect(response['A01'][1]).toBe('1001');
  });

  it('should parse WKCNTR response correctly', () => {
    const response = parseResponse(MOCK_RESPONSES['WKCNTR']);
    expect(response['A01']).toBeDefined();
    expect(response['A01'][1]).toBe('78');
    expect(response['A01'][2]).toBe('200');
  });

  it('should parse ALARM response correctly', () => {
    const response = parseResponse(MOCK_RESPONSES['ALARM']);
    expect(response['E01']).toBeDefined();
    expect(response['E01'][0]).toBe('0975320032');
  });

  it('should parse PDSP response correctly', () => {
    const response = parseResponse(MOCK_RESPONSES['PDSP']);
    expect(response['X01']).toBeDefined();
    expect(response['X01'][3]).toBe('10');
  });

  it('should handle empty lines gracefully', () => {
    const response = parseResponse('A01,1,2,3\r\n\r\nB01,4,5,6');
    expect(response['A01']).toEqual(['1', '2', '3']);
    expect(response['B01']).toEqual(['4', '5', '6']);
  });

  it('should parse comma-separated values', () => {
    const response = parseResponse('A01,value1,value2,value3\r\n');
    expect(response['A01']).toEqual(['value1', 'value2', 'value3']);
  });

  it('should skip lines without comma', () => {
    const response = parseResponse('HEADER\r\nA01,value\r\n');
    expect(response['HEADER']).toBeUndefined();
    expect(response['A01']).toEqual(['value']);
  });

  it('should trim whitespace from values', () => {
    const response = parseResponse('A01,  spaced  , value \r\n');
    expect(response['A01']).toEqual(['spaced', 'value']);
  });
});

describe('parseValue', () => {
  it('should parse string values', () => {
    expect(parseValue('hello', 'string')).toBe('hello');
  });

  it('should parse int values', () => {
    expect(parseValue('42', 'int')).toBe(42);
    expect(parseValue('3.7', 'int')).toBe(3);
  });

  it('should parse float values', () => {
    expect(parseValue('3.14', 'float')).toBe(3.14);
  });

  it('should parse bool values', () => {
    expect(parseValue('true', 'bool', (v) => Boolean(v))).toBe(true);
  });

  it('should strip quotes from strings', () => {
    expect(parseValue("'quoted'", 'string')).toBe('quoted');
  });

  it('should handle empty values with defaults', () => {
    expect(parseValue('', 'int')).toBe(0);
    expect(parseValue('', 'float')).toBe(0);
    expect(parseValue('', 'bool')).toBe(false);
    expect(parseValue('', 'string')).toBe('');
  });

  it('should apply transform function', () => {
    const double: DataItemTransform = (v) => parseInt(String(v)) * 2;
    expect(parseValue('5', 'int', double)).toBe(10);
  });
});

describe('TRANSFORMS.mode', () => {
  it.each([
    ['0', 'MANUAL'],
    ['1', 'MDI'],
    ['2', 'MEMORY'],
    ['3', 'EDIT'],
  ])('should transform %s to %s', (panelValue, mode) => {
    expect(TRANSFORMS.mode(panelValue)).toBe(mode);
  });

  it('should return raw int for unknown values', () => {
    expect(TRANSFORMS.mode('4')).toBe(4);
    expect(TRANSFORMS.mode('99')).toBe(99);
  });
});

describe('TRANSFORMS.alarm', () => {
  it('should return false for CM (Communication) alarm - ignored', () => {
    expect(TRANSFORMS.alarm('0975320032')).toBe(false);
  });

  it('should return false for OM (No alarm) - ignored', () => {
    expect(TRANSFORMS.alarm('90')).toBe(false);
    expect(TRANSFORMS.alarm('90000000')).toBe(false);
  });

  it('should return true for real alarms', () => {
    expect(TRANSFORMS.alarm('01123456')).toBe(true);  // EX
    expect(TRANSFORMS.alarm('02123456')).toBe(true);  // EC
    expect(TRANSFORMS.alarm('03123456')).toBe(true);  // SV
    expect(TRANSFORMS.alarm('04123456')).toBe(true);  // NC
    expect(TRANSFORMS.alarm('05123456')).toBe(true);  // IO
    expect(TRANSFORMS.alarm('06123456')).toBe(true);  // SP
    expect(TRANSFORMS.alarm('10123456')).toBe(true);  // ES
  });
});

describe('TRANSFORMS.alarmCode', () => {
  it.each([
    ['01', 'EX'], ['02', 'EC'], ['03', 'SV'], ['04', 'NC'], ['05', 'IO'], ['06', 'SP'],
    ['07', 'SM'], ['08', 'SL'], ['09', 'CM'], ['10', 'ES'], ['11', 'FC'],
  ])('maps prefix %s to %s', (prefix, letters) => {
    expect(TRANSFORMS.alarmCode(`${prefix}123456`)).toBe(`${letters}123456`);
  });

  it('should transform CM alarm code correctly', () => {
    expect(TRANSFORMS.alarmCode('0975320032')).toBe('CM75320032');
  });

  it('should return empty string for OM (No alarm)', () => {
    expect(TRANSFORMS.alarmCode('90')).toBe('');
    expect(TRANSFORMS.alarmCode('90000000')).toBe('');
  });

  it('should return raw value for unknown codes', () => {
    expect(TRANSFORMS.alarmCode('99unknown')).toBe('99unknown');
  });
});

describe('TRANSFORMS.execution, from the MEM operation status', () => {
  it('gives the MTConnect execution word for each status', () => {
    expect(TRANSFORMS.execution('0')).toBe('READY');
    expect(TRANSFORMS.execution('1')).toBe('ACTIVE');
    expect(TRANSFORMS.execution('2')).toBe('FEED_HOLD');
    expect(TRANSFORMS.execution('3')).toBe('INTERRUPTED');
  });

  it('gives an empty value for a status that it does not know', () => {
    expect(TRANSFORMS.execution('7')).toBe('');
  });
});

/** The real reply of a Speedio X500 (C00) to ATCTLD: status 08, a command that it does not know */
const UNKNOWN_ATCTLD = 'RLOD    ATCTLD  08\r\n02%';

describe('the reply status', () => {
  it('gives the status of the header line', () => {
    expect(parseResponse(UNKNOWN_ATCTLD)[REPLY_STATUS_KEY]).toEqual(['08']);
    expect(parseResponse(MOCK_RESPONSES.PANEL)[REPLY_STATUS_KEY]).toEqual(['00']);
    expect(parseResponse(MOCK_RESPONSES.TOLNI1)[REPLY_STATUS_KEY]).toEqual(['00']);
  });

  it('gives no status when the reply has no header line', () => {
    expect(parseResponse('A01,1\r\n')).not.toHaveProperty(REPLY_STATUS_KEY);
  });
});

describe('isKnownAtcReply', () => {
  it('is true for status 00, with pots and with no pots (an empty magazine)', () => {
    expect(isKnownAtcReply(parseResponse(MOCK_RESPONSES.ATCTL))).toBe(true);
    expect(isKnownAtcReply(parseResponse('RLOD    ATCTL   00\r\n\r\n00%'))).toBe(true);
  });

  it('is false for another status, also with pots', () => {
    expect(isKnownAtcReply(parseResponse(UNKNOWN_ATCTLD))).toBe(false);
    expect(isKnownAtcReply(parseResponse('RLOD    ATCTL   08\r\nM02,  1,0,0\r\n\r\n00%'))).toBe(false);
  });

  it('with no status line, is true only when the reply has pots', () => {
    expect(isKnownAtcReply(parseResponse('M02,  1,0,0\r\n'))).toBe(true);
    expect(isKnownAtcReply(parseResponse('T01, 1.5\r\n'))).toBe(false);
  });
});

describe('the tool table from the replies of a tool read', () => {
  it('gives the tool in each pot: key M02 is pot 1', () => {
    expect(potToolsOf(parseResponse(MOCK_RESPONSES.ATCTL))).toEqual({ 1: 1, 2: 2 });
  });

  it('skips a pot with no tool or a tool number out of 1 to 99, and reads up to key M51 (pot 50)', () => {
    const reply = 'M02,  0,0,0\r\nM03,100,0,0\r\nM04,  7,0,0\r\nM51, 99,0,0\r\nM52,  5,0,0\r\n';
    expect(potToolsOf(parseResponse(reply))).toEqual({ 3: 7, 50: 99 });
  });

  it('gives the offsets and the name of each tool, with no quotes', () => {
    expect(toolOffsetsOf(parseResponse(MOCK_RESPONSES.TOLNI1)).get(1))
      .toEqual({ length: 1.5, lengthWear: 0, diameter: 0.25, diameterWear: 0, name: 'ENDMILL' });
  });

  it('reads tool data with 3-digit keys', () => {
    const reply = "T001, 1.5000, 0.0001, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n";
    expect(toolOffsetsOf(parseResponse(reply)).get(1)).toMatchObject({ length: 1.5, lengthWear: 0.0001, name: 'ENDMILL' });
  });

  it('gives 0 for a value that is not a number, and an empty name when the row has no name', () => {
    expect(toolOffsetsOf(parseResponse('T02, x, , 0.5\r\n')).get(2))
      .toEqual({ length: 0, lengthWear: 0, diameter: 0.5, diameterWear: 0, name: '' });
  });

  it('puts the offsets of the tool in each pot in the table, and only the tool number when it has no offsets', () => {
    const table = toolTableOf(potToolsOf(parseResponse(MOCK_RESPONSES.ATCTL)), toolOffsetsOf(parseResponse(MOCK_RESPONSES.TOLNI1)));

    expect(table).toEqual({
      1: { toolNum: 1, length: 1.5, lengthWear: 0, diameter: 0.25, diameterWear: 0, name: 'ENDMILL' },
      2: { toolNum: 2 },
    });
  });

  it('gives an empty table when there are no pots', () => {
    expect(toolTableOf({}, toolOffsetsOf(parseResponse(MOCK_RESPONSES.TOLNI1)))).toEqual({});
  });
});

/** A communication message (CM, category 09). A Speedio adds one after it gets a command that it does not know. */
const CM_ENTRY = '0975220008';
const SV_ALARM = '0312345678';
const EMPTY_SLOT = ' '.repeat(10);

describe('alarmOfList', () => {
  it('gives no alarm for an empty list, or a list of empty slots', () => {
    expect(alarmOfList([])).toEqual({ alarm: false, alarmCode: '' });
    expect(alarmOfList([EMPTY_SLOT, EMPTY_SLOT])).toEqual({ alarm: false, alarmCode: '' });
  });

  it('gives no alarm when the list has only a communication message', () => {
    expect(alarmOfList([CM_ENTRY, EMPTY_SLOT])).toEqual({ alarm: false, alarmCode: '' });
  });

  it('gives the first real alarm, after a communication message or a "no alarm" entry', () => {
    expect(alarmOfList([CM_ENTRY, SV_ALARM])).toEqual({ alarm: true, alarmCode: 'SV12345678' });
    expect(alarmOfList(['9000000000', '0512340000', SV_ALARM])).toEqual({ alarm: true, alarmCode: 'IO12340000' });
  });
});

describe('the values of the machine state', () => {
  const replies = Object.fromEntries(Object.entries(MOCK_RESPONSES).map(([command, reply]) => [command, parseResponse(reply)]));

  it('reads each standard data item and the alarm list', () => {
    expect(machineValuesOf(replies, DATA_ITEMS)).toEqual({
      mode: 'MANUAL', program: '1001', execution: 'READY', partCount: 78, partGoal: 200, toolNumber: 10, spindleSpeed: 0,
      alarm: false, alarmCode: '',
    });
  });

  it('gives no value for an item whose reply did not come, and no alarm with no alarm list', () => {
    const { MEM: _mem, ALARM: _alarm, ...others } = replies;

    const values = machineValuesOf(others, DATA_ITEMS);

    expect(values).not.toHaveProperty('program');
    expect(values).not.toHaveProperty('execution');
    expect(values).not.toHaveProperty('alarm');
    expect(values.partCount).toBe(78);
  });

  it('reads a macro value from its C line', () => {
    const item = macroDataItem('Count', 'MCRNI1', 100);

    expect(item).toEqual(['Count', 'MCRNI1', 'C100', 0, 'float']);
    expect(machineValuesOf({ MCRNI1: parseResponse('RLOD    MCRNI1  00\r\nC100, 42.0000\r\n') }, [item])).toEqual({ Count: 42 });
  });

  it('sends each command of a read one time, and the alarm list last', () => {
    expect(stateCommandsOf([...DATA_ITEMS, macroDataItem('Count', 'MCRNI1', 100), macroDataItem('Other', 'MCRNI1', 101)]))
      .toEqual(['PANEL', 'MEM', 'WKCNTR', 'PDSP', 'MCRNI1', 'ALARM']);
  });
});
