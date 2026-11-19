import { describe, expect, it } from 'vitest';
import { clipSegments, segmentAt, stateTotals, timelineStateOf, withLiveState, type StateSegment } from './stateTimeline';

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

describe('withLiveState', () => {
  it('keeps the segments when the live state is the same as the last one', () => {
    const segments = [segment('running', 0, 100)];

    expect(withLiveState(segments, 'running', 150)).toBe(segments);
  });

  it('holds the last state until the change, then starts a new segment', () => {
    expect(withLiveState([segment('running', 0, 100)], 'idle', 150)).toEqual([segment('running', 0, 150), segment('idle', 150, 150)]);
  });

  it('starts the timeline with the live state when there is none', () => {
    expect(withLiveState([], 'idle', 150)).toEqual([segment('idle', 150, 150)]);
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
