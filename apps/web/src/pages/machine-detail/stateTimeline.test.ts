import { describe, expect, it } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { clipSegments, liveStateOf, segmentTimesText, segmentAt, stateTotals, timelineStateOf, withLiveState, type StateSegment } from './stateTimeline';

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
    const lastPollTime = '2026-11-19T12:00:00.000Z';
    const machine = testMachine({ connected: true, lastPollTime }, { execution: 'ACTIVE', program: 'O1001' });
    // The time is the server's poll time, the same clock as the saved timeline, not the browser's clock
    expect(liveStateOf(machine)).toEqual({ state: 'running', program: 'O1001', time: Date.parse(lastPollTime) });
  });

  it('gives no program for an offline machine, because its program is old', () => {
    const lastPollTime = '2026-11-19T12:00:00.000Z';
    expect(liveStateOf(testMachine({ connected: false, lastPollTime }, { program: 'O1001' }))).toEqual({ state: 'offline', time: Date.parse(lastPollTime) });
  });
});

describe('withLiveState', () => {
  it('keeps the segments when the live state and program are the same as the last ones', () => {
    const segments = [{ ...segment('running', 0, 100), program: 'O1' }];

    expect(withLiveState(segments, { state: 'running', program: 'O1', time: 150 })).toBe(segments);
  });

  it('holds the last state until the change, then starts a new segment', () => {
    expect(withLiveState([segment('running', 0, 100)], { state: 'idle', time: 150 })).toEqual([segment('running', 0, 150), segment('idle', 150, 150)]);
  });

  it('starts a new segment when the program changes and the state does not', () => {
    const segments = [{ ...segment('running', 0, 100), program: 'O1' }];

    expect(withLiveState(segments, { state: 'running', program: 'O2', time: 150 })).toEqual([
      { ...segment('running', 0, 150), program: 'O1' },
      { ...segment('running', 150, 150), program: 'O2' },
    ]);
  });

  it('cuts the last segment at the change when the change time is before its end, so no two segments overlap', () => {
    // The saved timeline ends at 150 (server time); the live change came at 120
    expect(withLiveState([segment('running', 0, 150)], { state: 'idle', time: 120 })).toEqual([segment('running', 0, 120), segment('idle', 120, 120)]);
  });

  it('never starts a change before the last segment starts', () => {
    expect(withLiveState([segment('running', 100, 150)], { state: 'idle', time: 50 })).toEqual([segment('running', 100, 100), segment('idle', 100, 100)]);
  });

  it('starts the timeline with the live state when there is none', () => {
    expect(withLiveState([], { state: 'idle', time: 150 })).toEqual([segment('idle', 150, 150)]);
  });
});

describe('clipSegments', () => {
  it('cuts the segments to the range, and holds the last state until now', () => {
    const segments = [segment('offline', 0, 50), segment('running', 50, 100), segment('idle', 100, 120)];

    expect(clipSegments(segments, 60, 200)).toEqual([segment('running', 60, 100), segment('idle', 100, 200)]);
  });

  it('ends the last state at the time it was last known, when the live state is not known now', () => {
    const segments = [segment('offline', 0, 50), segment('running', 50, 100)];

    expect(clipSegments(segments, 0, 200, 120)).toEqual([segment('offline', 0, 50), segment('running', 50, 120)]);
  });

  it('keeps a state that just changed, before it has any length', () => {
    const segments = [segment('idle', 0, 150), segment('running', 150, 150)];

    expect(clipSegments(segments, 0, 150)).toEqual([segment('idle', 0, 150), segment('running', 150, 150)]);
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

  it('finds the last segment at its end, which is the newest live time', () => {
    const segments = [segment('running', 0, 40), segment('idle', 40, 100)];

    expect(segmentAt(segments, 40)?.state).toBe('idle');
    expect(segmentAt(segments, 100)?.state).toBe('idle');
  });
});

describe('segmentTimesText', () => {
  it('gives the date once when the segment starts and ends on the same day', () => {
    const start = new Date(2026, 10, 19, 8, 0).getTime();
    const end = new Date(2026, 10, 19, 14, 0).getTime();

    expect(segmentTimesText(start, end)).toBe(`${new Date(start).toLocaleString()} – ${new Date(end).toLocaleTimeString()}`);
  });

  it('gives both dates when the segment goes over midnight, so a long offline time is clear', () => {
    const start = new Date(2026, 10, 17, 8, 0).getTime();
    const end = new Date(2026, 10, 18, 14, 0).getTime();

    expect(segmentTimesText(start, end)).toBe(`${new Date(start).toLocaleString()} – ${new Date(end).toLocaleString()}`);
  });
});
