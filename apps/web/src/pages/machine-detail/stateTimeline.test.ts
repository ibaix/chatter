import { describe, expect, it } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { clipSegments, liveStateOf, segmentAt, stateTotals, timelineStateOf, withLiveState, type StateSegment } from './stateTimeline';

const segment = (state: StateSegment['state'], start: number, end: number, detail?: string): StateSegment =>
  detail === undefined ? { state, start, end } : { state, start, end, detail };

describe('timelineStateOf', () => {
  it('gives the timeline state of a dashboard state, and nothing while the machine connects', () => {
    expect(timelineStateOf('running')).toBe('running');
    expect(timelineStateOf('alarm')).toBe('alarm');
    expect(timelineStateOf('offline')).toBe('offline');
    expect(timelineStateOf('connecting')).toBeUndefined();
  });
});

describe('liveStateOf', () => {
  it('gives the state and the program of a connected machine', () => {
    const machine = testMachine({ connected: true }, { execution: 'ACTIVE', program: 'O1001' });
    expect(liveStateOf(machine)).toEqual({ state: 'running', program: 'O1001' });
  });

  it('gives no program for an offline machine, because its program is old', () => {
    expect(liveStateOf(testMachine({ connected: false }, { program: 'O1001' }))).toEqual({ state: 'offline' });
  });
});

describe('withLiveState', () => {
  it('keeps the segments when the live state and program are the same as the last ones', () => {
    const segments = [{ ...segment('running', 0, 100), program: 'O1' }];

    expect(withLiveState(segments, { state: 'running', program: 'O1' }, 150)).toBe(segments);
  });

  it('holds the last state until the change, then starts a new segment', () => {
    expect(withLiveState([segment('running', 0, 100)], { state: 'idle' }, 150)).toEqual([segment('running', 0, 150), segment('idle', 150, 150)]);
  });

  it('starts a new segment when the program changes and the state does not', () => {
    const segments = [{ ...segment('running', 0, 100), program: 'O1' }];

    expect(withLiveState(segments, { state: 'running', program: 'O2' }, 150)).toEqual([
      { ...segment('running', 0, 150), program: 'O1' },
      { ...segment('running', 150, 150), program: 'O2' },
    ]);
  });

  it('starts the timeline with the live state when there is none', () => {
    expect(withLiveState([], { state: 'idle' }, 150)).toEqual([segment('idle', 150, 150)]);
  });
});

describe('clipSegments', () => {
  it('cuts the segments to the range, and holds the last state until now', () => {
    const segments = [segment('offline', 0, 50), segment('running', 50, 100), segment('idle', 100, 120)];

    expect(clipSegments(segments, 60, 200)).toEqual([segment('running', 60, 100), segment('idle', 100, 200)]);
  });
});

describe('stateTotals', () => {
  it('adds the time of each state, in the order of the legend', () => {
    const segments = [segment('running', 0, 40), segment('idle', 40, 50), segment('alarm', 50, 52, '1001'), segment('running', 52, 100)];

    expect(stateTotals(segments)).toEqual([
      { state: 'running', ms: 88 },
      { state: 'idle', ms: 10 },
      { state: 'alarm', ms: 2 },
      { state: 'offline', ms: 0 },
    ]);
  });
});

describe('segmentAt', () => {
  it('finds the segment at a time, for the hover box', () => {
    const segments = [segment('running', 0, 40), segment('idle', 40, 100)];

    expect(segmentAt(segments, 40)).toEqual(segment('idle', 40, 100));
    expect(segmentAt(segments, 200)).toBeUndefined();
  });
});
