import { describe, expect, it } from 'vitest';
import { autoHistoryWindow, HISTORY_VALUES, historyWindowValue } from './history.js';

describe('historyWindowValue', () => {
  it('takes the last value of a counter or a number that has no middle, because an average such as T7.4 means nothing', () => {
    expect(['part-count', 'part-goal', 'tool-number'].map(value => historyWindowValue(value as never))).toEqual(['last', 'last', 'last']);
  });

  it('takes the average of a measured value and of a state', () => {
    const others = HISTORY_VALUES.filter(value => !['part-count', 'part-goal', 'tool-number'].includes(value));
    expect(new Set(others.map(historyWindowValue))).toEqual(new Set(['average']));
  });
});

describe('autoHistoryWindow', () => {
  const HOUR = 3_600_000;

  it('picks the smallest window that keeps the range within 1000 points', () => {
    expect(autoHistoryWindow(HOUR)).toBe('10s');
    expect(autoHistoryWindow(3 * HOUR)).toBe('30s');
    expect(autoHistoryWindow(24 * HOUR)).toBe('5m');
    expect(autoHistoryWindow(7 * 24 * HOUR)).toBe('15m');
  });

  it('gives the biggest window for a very long range', () => {
    expect(autoHistoryWindow(10_000 * 24 * HOUR)).toBe('1d');
  });
});
