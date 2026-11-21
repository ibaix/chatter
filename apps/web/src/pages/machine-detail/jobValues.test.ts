import { describe, expect, it } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { jobValuesOf } from './jobValues';

const labelsOf = (machine: Parameters<typeof jobValuesOf>[0]) => jobValuesOf(machine).map(item => item.label);

describe('jobValuesOf', () => {
  it('shows a dash for each value when the machine is offline', () => {
    const values = jobValuesOf(testMachine({ connected: false }, { program: 'O1234' }));
    expect(values.map(item => item.value)).toEqual(['—', '—', '—', '—', '—']);
  });

  it('shows a dash for each value while the machine is connecting, also when the network connection is open', () => {
    const values = jobValuesOf(testMachine({ connected: true, connecting: true }, { program: 'O1234' }));
    expect(values.map(item => item.value)).toEqual(['—', '—', '—', '—', '—']);
  });

  it('gives the job values with the part fraction', () => {
    const values = jobValuesOf(testMachine({}, { mode: 'MEM', program: 'O1234', partCount: 5, partGoal: 10, spindleSpeed: 8000, toolNumber: 3 }));
    expect(values).toEqual([
      { label: 'Mode', value: 'MEM' },
      { label: 'Program', value: 'O1234' },
      { label: 'Parts', value: '5 / 10', fraction: 0.5, chartValue: 'part-count' },
      { label: 'Spindle', value: '8,000 rpm', chartValue: 'spindle-speed' },
      { label: 'Tool', value: 'T3', chartValue: 'tool-number' },
    ]);
  });

  it('adds the spindle load after the spindle speed, with a bar that is full at 100%', () => {
    const values = jobValuesOf(testMachine({}, { spindleSpeed: 8000, spindleLoad: 37.4 }));
    expect(values).toContainEqual({ label: 'Spindle load', value: '37%', fraction: 0.374, chartValue: 'spindle-load' });
    expect(values.map(item => item.label).slice(3, 5)).toEqual(['Spindle', 'Spindle load']);

    const overload = jobValuesOf(testMachine({}, { spindleLoad: 130 }));
    expect(overload).toContainEqual({ label: 'Spindle load', value: '130%', fraction: 1, chartValue: 'spindle-load' });
  });

  it('leaves out the spindle load when the machine does not send it, because some machines cannot', () => {
    expect(labelsOf(testMachine({}, { spindleSpeed: 8000 }))).not.toContain('Spindle load');
  });

  it('adds "Execution" for MTConnect and the operator message for FANUC', () => {
    expect(labelsOf(testMachine({ type: 'mtconnect' } as never))).toContain('Execution');
    expect(labelsOf(testMachine({ type: 'fanuc' } as never, { operatorMessage: 'Check coolant' }))).toContain('Operator message');
  });

  it('adds the warning of a FANUC control, such as a low battery', () => {
    const machine = testMachine({ type: 'fanuc' } as never, { warning: 'Battery low' });
    expect(jobValuesOf(machine)).toContainEqual({ label: 'Warning', value: 'Battery low' });
    expect(labelsOf(testMachine({ type: 'fanuc' } as never))).not.toContain('Warning');
  });

  describe('a FANUC control with two paths (a two-path lathe)', () => {
    // As probed on a 0i-TT: O6000 runs on path 1 and turns only the sub-spindle S3 of path 2
    const paths = [
      {
        path: 1, runState: 'START', motion: 2, program: 'O6000', programPath: '//DATA_SV/O6000',
        spindles: [{ name: 'S1', speed: 0, load: 0 }, { name: 'S2', speed: 0, load: 0 }],
      },
      { path: 2, runState: 'RESET', motion: 0, program: 'O5000', programPath: '//DATA_SV/O5000', spindles: [{ name: 'S3', speed: 500, load: 3.4 }] },
    ];
    const lathe = testMachine({ type: 'fanuc' } as never, {
      mode: 'MEMORY', runState: 'START', program: 'O6000', spindleSpeed: 0, spindleLoad: 0, toolNumber: 1001, partCount: 4, paths,
    });

    it('adds the run state and program of each path, and each spindle after the main one by name', () => {
      expect(jobValuesOf(lathe).slice(-5)).toEqual([
        { label: 'Tool', value: 'T1001', chartValue: 'tool-number' },
        { label: 'Path 1', value: 'START · O6000' },
        { label: 'Path 2', value: 'RESET · O5000' },
        { label: 'Spindle S2', value: '0 rpm · 0%' },
        { label: 'Spindle S3', value: '500 rpm · 3%' },
      ]);
    });

    it('shows the full name of the main program', () => {
      expect(jobValuesOf(lathe)).toContainEqual({ label: 'Program', value: '//DATA_SV/O6000' });
    });

    it('shows a dash for a spindle that sends no values, and the S3 of path 2 also when path 1 sends no spindles', () => {
      const noSpindles = testMachine({ type: 'fanuc' } as never, {
        paths: [{ path: 1, runState: 'RESET', spindles: [] }, { path: 2, spindles: [{ name: 'S3' }] }],
      });
      expect(jobValuesOf(noSpindles).slice(-3)).toEqual([
        { label: 'Path 1', value: 'RESET' },
        { label: 'Path 2', value: '—' },
        { label: 'Spindle S3', value: '—' },
      ]);
    });

    it('adds no path rows for a control with one path', () => {
      const oneTurret = testMachine({ type: 'fanuc' } as never, { program: 'O1234' });
      expect(labelsOf(oneTurret)).not.toContain('Path 1');
      expect(jobValuesOf(oneTurret)).toContainEqual({ label: 'Program', value: 'O1234' });
    });
  });

  it('adds each macro variable by name, or by location', () => {
    const machine = testMachine({ macros: [{ location: 500, name: 'Offset' }, { location: 501 }] }, { Offset: 1.5 });
    expect(jobValuesOf(machine).slice(-2)).toEqual([
      { label: 'Offset', value: '1.5' },
      { label: 'Macro 501', value: '—' },
    ]);
  });

  it('adds the Siemens program state, tool name and feed override, and names R parameters', () => {
    const machine = testMachine(
      { type: 'siemens', macros: [{ location: 5 }, { location: 7, name: 'Stock' }] } as never,
      { programStatus: 'RUNNING', toolName: 'VF-6.0-UNI', feedOverride: 99.6, macro_5: 1.5, Stock: 12.5 },
    );
    expect(jobValuesOf(machine).slice(-5)).toEqual([
      { label: 'Program state', value: 'RUNNING' },
      { label: 'Tool name', value: 'VF-6.0-UNI' },
      { label: 'Feed override', value: '100%' },
      { label: 'R5', value: '1.5' },
      { label: 'Stock', value: '12.5' },
    ]);
  });

  it('leaves out the row of the value that the chart shows, so it is not on the page twice', () => {
    const machine = testMachine({}, { spindleSpeed: 8000, spindleLoad: 37, partCount: 5 });
    expect(labelsOf(machine)).toEqual(expect.arrayContaining(['Parts', 'Spindle', 'Spindle load']));
    expect(jobValuesOf(machine, 'spindle-speed').map(item => item.label)).not.toContain('Spindle');
    expect(jobValuesOf(machine, 'spindle-load').map(item => item.label)).toEqual(expect.arrayContaining(['Spindle', 'Parts']));
    expect(jobValuesOf(machine, 'spindle-load').map(item => item.label)).not.toContain('Spindle load');
    expect(jobValuesOf(machine, 'part-count').map(item => item.label)).not.toContain('Parts');
    expect(jobValuesOf(machine, 'tool-number').map(item => item.label)).not.toContain('Tool');
  });

  it('also leaves out the chart value when the machine is offline', () => {
    expect(jobValuesOf(testMachine({ connected: false }), 'spindle-speed').map(item => item.label)).toEqual(['Mode', 'Program', 'Parts', 'Tool']);
  });
});
