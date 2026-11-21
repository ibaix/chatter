import { describe, expect, it } from 'vitest';
import { combinedRunState, isMachineRunning, isProgramEnded, isRunningStateText, type RunningValues } from './running.js';

describe('isMachineRunning', () => {
  it.each([
    ['START', true],
    ['MSTR', true],
    ['STOP', false],
    ['HOLD', false],
    ['RESET', false],
  ])('counts the FANUC run state %s as running: %s', (runState, running) => {
    expect(isMachineRunning({ runState })).toBe(running);
  });

  it.each([
    ['ACTIVE', true],
    ['READY', false],
    ['FEED_HOLD', false],
    ['INTERRUPTED', false],
    ['STOPPED', false],
  ])('counts the execution %s as running: %s', (execution, running) => {
    expect(isMachineRunning({ execution })).toBe(running);
  });

  it('does not count a turning spindle while the program is held', () => {
    const heldFanuc = { runState: 'HOLD', spindleSpeed: 8000 };
    const heldMTConnect = { execution: 'FEED_HOLD', spindleSpeed: 8000 };
    expect(isMachineRunning(heldFanuc)).toBe(false);
    expect(isMachineRunning(heldMTConnect)).toBe(false);
  });

  it('does not know when the machine tells neither a run state nor an execution', () => {
    const spindleOnly: RunningValues & { spindleSpeed: number } = { spindleSpeed: 8000 };
    expect(isMachineRunning({})).toBeUndefined();
    expect(isMachineRunning(spindleOnly)).toBeUndefined();
  });
});

describe('combinedRunState', () => {
  it('gives the state of the main path when no path runs', () => {
    expect(combinedRunState(['RESET', 'RESET'])).toBe('RESET');
    expect(combinedRunState(['HOLD', 'RESET'])).toBe('HOLD');
    expect(combinedRunState(['RESET', 'STOP'])).toBe('RESET');
  });

  it('gives the state of a path that runs, so the machine runs when any path runs', () => {
    expect(combinedRunState(['START', 'RESET'])).toBe('START');
    expect(combinedRunState(['RESET', 'START'])).toBe('START');
    expect(combinedRunState(['STOP', 'MSTR'])).toBe('MSTR');
    expect(isMachineRunning({ runState: combinedRunState(['RESET', 'START']) })).toBe(true);
  });

  it('gives the state of a control with one path as it is', () => {
    expect(combinedRunState(['STOP'])).toBe('STOP');
    expect(combinedRunState([])).toBeUndefined();
  });
});

describe('isProgramEnded', () => {
  it.each([
    ['RESET', true],
    ['STOP', false],
    ['HOLD', false],
    ['START', false],
    ['MSTR', false],
  ])('FANUC: counts the run state %s as a program end: %s', (runState, ended) => {
    expect(isProgramEnded({ runState })).toBe(ended);
  });

  // Brother (operation status), Haas (Q500), Siemens (channel status) and MTConnect all give execution words
  it.each([
    ['READY', true],
    ['PROGRAM_COMPLETED', true],
    // A Haas gives STOPPED for ALARM ON, and an MTConnect control for a stop by the operator
    ['STOPPED', false],
    ['ACTIVE', false],
    ['FEED_HOLD', false],
    ['INTERRUPTED', false],
    ['OPTIONAL_STOP', false],
    ['PROGRAM_STOPPED', false],
    ['WAIT', false],
    ['UNKNOWN_7', false],
  ])('counts the execution %s as a program end: %s', (execution, ended) => {
    expect(isProgramEnded({ execution })).toBe(ended);
  });

  it('does not count a stop for an alarm or an emergency stop', () => {
    expect(isProgramEnded({ runState: 'RESET', alarm: true })).toBe(false);
    expect(isProgramEnded({ runState: 'RESET', emergency: true })).toBe(false);
    expect(isProgramEnded({ execution: 'PROGRAM_COMPLETED', alarm: true })).toBe(false);
    expect(isProgramEnded({ execution: 'READY', emergency: true })).toBe(false);
    expect(isProgramEnded({ execution: 'READY', alarm: false, emergency: false })).toBe(true);
  });

  it('does not know when the machine tells neither a run state nor an execution', () => {
    expect(isProgramEnded({})).toBeUndefined();
    expect(isProgramEnded({ alarm: true })).toBeUndefined();
  });
});

describe('isRunningStateText', () => {
  it.each([
    ['START', true],
    ['MSTR', true],
    ['ACTIVE', true],
    ['HOLD', false],
    ['FEED_HOLD', false],
    ['READY', false],
  ])('counts the saved run state %s as running: %s', (text, running) => {
    expect(isRunningStateText(text)).toBe(running);
  });
});
