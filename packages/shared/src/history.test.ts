import { describe, expect, it } from 'vitest';
import { HISTORY_VALUES, historyWindowValue } from './history.js';

describe('historyWindowValue', () => {
  it('takes the last value of a counter or a number that has no middle, because an average such as T7.4 means nothing', () => {
    expect(['part-count', 'part-goal', 'tool-number'].map(value => historyWindowValue(value as never))).toEqual(['last', 'last', 'last']);
  });

  it('takes the average of a measured value and of a state', () => {
    const others = HISTORY_VALUES.filter(value => !['part-count', 'part-goal', 'tool-number'].includes(value));
    expect(new Set(others.map(historyWindowValue))).toEqual(new Set(['average']));
  });
});
