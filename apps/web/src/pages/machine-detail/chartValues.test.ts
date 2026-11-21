import { describe, expect, it } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { chartChoicesFor, chartValuesFor, shownChartChoice, SPINDLE_SPEED } from './chartValues';

const idsFor = (data: Parameters<typeof testMachine>[1]) => chartValuesFor(testMachine({}, data)).map(value => value.id);

describe('chartValuesFor', () => {
  it('offers only the spindle speed when the machine sends nothing else', () => {
    expect(idsFor({ spindleSpeed: 1200 })).toEqual(['spindle-speed']);
  });

  it('offers the spindle load and the part count when the machine sends them', () => {
    expect(idsFor({ spindleSpeed: 1200, spindleLoad: 30, partCount: 7 })).toEqual(['spindle-speed', 'spindle-load', 'part-count']);
  });

  it('offers the feedrate and the tool number when the machine sends them', () => {
    expect(idsFor({ spindleSpeed: 1200, feedrate: 500, toolNumber: 12 })).toEqual(['spindle-speed', 'feedrate', 'tool-number']);
  });
});

describe('chart value formats', () => {
  it('gives each value its unit', () => {
    const [speed, load, parts] = chartValuesFor(testMachine({}, { spindleLoad: 30, partCount: 7 }));
    expect(speed.format(8000.4)).toBe('8,000 RPM');
    expect(load.format(32.6)).toBe('33%');
    expect(parts.format(48)).toBe('48 parts');
  });

  it('gives the feedrate as a number, because the unit depends on the machine, and the tool as T12', () => {
    const [, feedrate, tool] = chartValuesFor(testMachine({}, { feedrate: 1500.4, toolNumber: 12 }));
    expect(feedrate.format(1500.4)).toBe('1,500');
    expect(tool.format(12)).toBe('T12');
  });
});

describe('chartChoicesFor', () => {
  it('offers the machine state first, then the values', () => {
    expect(chartChoicesFor(testMachine({}, { spindleSpeed: 1200 })).map(choice => choice.id)).toEqual(['machine-state', 'spindle-speed']);
  });

  it('shows the spindle speed when the chosen value is not sent now', () => {
    const choices = chartChoicesFor(testMachine({}, { spindleSpeed: 1200 }));
    expect(shownChartChoice(choices, 'spindle-load')).toBe(SPINDLE_SPEED);
    expect(shownChartChoice(choices, 'machine-state').id).toBe('machine-state');
  });
});
