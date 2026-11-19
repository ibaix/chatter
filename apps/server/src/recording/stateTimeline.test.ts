import { describe, expect, it } from 'vitest';
import type { StatePeriod } from './StatePeriodStore.js';
import { stateTimeline } from './stateTimeline.js';

const period = (kind: StatePeriod['kind'], value: string, start: number, end?: number): StatePeriod => ({ kind, value, start, end });

describe('stateTimeline', () => {
  it('shows a time with no period as offline', () => {
    expect(stateTimeline([], 0, 100)).toEqual([{ state: 'offline', start: 0, end: 100 }]);
  });

  it('shows a running run state as running, and another run state as idle', () => {
    const periods = [period('run-state', 'START', 0, 40), period('run-state', 'STOP', 40)];

    expect(stateTimeline(periods, 0, 100)).toEqual([
      { state: 'running', start: 0, end: 40 },
      { state: 'idle', start: 40, end: 100 },
    ]);
  });

  it('counts the MTConnect execution ACTIVE as running', () => {
    expect(stateTimeline([period('run-state', 'ACTIVE', 0)], 0, 10)).toEqual([{ state: 'running', start: 0, end: 10 }]);
  });

  it('shows an alarm over running, with the alarm text', () => {
    const periods = [period('run-state', 'START', 0), period('alarm', 'SV0401 Servo V-ready off', 30, 50)];

    expect(stateTimeline(periods, 0, 100)).toEqual([
      { state: 'running', start: 0, end: 30 },
      { state: 'alarm', start: 30, end: 50, detail: 'SV0401 Servo V-ready off' },
      { state: 'running', start: 50, end: 100 },
    ]);
  });

  it('shows a connected machine that sends no run state as idle, not offline', () => {
    // For example a Haas with no query port: it sends the program and the tool, but no run state
    const periods = [period('program', 'O1234', 10, 60), period('tool', '3', 10, 60)];

    expect(stateTimeline(periods, 0, 100)).toEqual([
      { state: 'offline', start: 0, end: 10 },
      { state: 'idle', start: 10, end: 60 },
      { state: 'offline', start: 60, end: 100 },
    ]);
  });

  it('joins neighbors with the same state, also when another kind changes between them', () => {
    const periods = [period('run-state', 'START', 0), period('tool', '1', 0, 20), period('tool', '2', 20)];

    expect(stateTimeline(periods, 0, 100)).toEqual([{ state: 'running', start: 0, end: 100 }]);
  });

  it('keeps two alarms with other texts apart', () => {
    const periods = [period('run-state', 'STOP', 0), period('alarm', '1001', 10, 20), period('alarm', '1002', 20, 30)];

    expect(stateTimeline(periods, 0, 40).map(segment => segment.detail ?? segment.state)).toEqual(['idle', '1001', '1002', 'idle']);
  });

  it('cuts the periods at the start and the end of the range', () => {
    expect(stateTimeline([period('run-state', 'START', -50, 150)], 0, 100)).toEqual([{ state: 'running', start: 0, end: 100 }]);
  });
});
