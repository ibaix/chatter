import { describe, expect, it } from 'vitest';
import { StatePeriodStore, type StatePeriod } from './StatePeriodStore.js';
import { readTimelinePeriods, stateTimeline } from './stateTimeline.js';

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
      { state: 'idle', start: 10, end: 60, program: 'O1234' },
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

  it('gives each segment the program that was open, and starts a new segment when the program changes', () => {
    const periods = [
      period('run-state', 'START', 0),
      period('program', 'O1001', 0, 40),
      period('program', 'O1002', 40),
    ];

    expect(stateTimeline(periods, 0, 100)).toEqual([
      { state: 'running', start: 0, end: 40, program: 'O1001' },
      { state: 'running', start: 40, end: 100, program: 'O1002' },
    ]);
  });
});

describe('readTimelinePeriods', () => {
  it('reads all the periods of the range when there are not too many', () => {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'run-state', 'START', 10);

    expect(readTimelinePeriods(store, { machineId: 'm1', from: 0, to: 100, limit: 3 })).toEqual({
      periods: [period('run-state', 'START', 10)],
      from: 0,
      more: false,
    });
  });

  it('starts at the oldest period it read when there are too many, and keeps a long period that is open then', () => {
    const store = StatePeriodStore.inMemory();
    // A run state open the whole time, while the tool changes often
    store.open('m1', 'run-state', 'START', 5);
    for (const [tool, start] of [['1', 10], ['2', 20], ['3', 30], ['4', 40]] as const) {
      if (start > 10) store.close('m1', 'tool', start);
      store.open('m1', 'tool', tool, start);
    }

    const read = readTimelinePeriods(store, { machineId: 'm1', from: 0, to: 100, limit: 3 });

    expect(read.more).toBe(true);
    expect(read.from).toBe(20);
    expect(read.periods.map(found => `${found.kind} ${found.value}`).sort()).toEqual(['run-state START', 'tool 2', 'tool 3', 'tool 4']);
    expect(stateTimeline(read.periods, read.from, 100)).toEqual([{ state: 'running', start: 20, end: 100 }]);
  });

  it('never starts before the range, also when the oldest period read is older', () => {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'run-state', 'START', -100);
    store.open('m1', 'tool', '1', -50);
    store.close('m1', 'tool', 10);
    store.open('m1', 'tool', '2', 10);

    const read = readTimelinePeriods(store, { machineId: 'm1', from: 0, to: 100, limit: 2 });

    expect(read).toMatchObject({ from: 0, more: true });
    expect(stateTimeline(read.periods, read.from, 100)).toEqual([{ state: 'running', start: 0, end: 100 }]);
  });
});
