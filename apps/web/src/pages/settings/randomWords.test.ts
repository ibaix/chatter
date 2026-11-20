import { describe, expect, it } from 'vitest';
import { RANDOM_WORDS, randomWords } from './randomWords';

describe('RANDOM_WORDS', () => {
  it('has 1024 different words, so three words give 30 bits of chance', () => {
    expect(RANDOM_WORDS).toHaveLength(1024);
    expect(new Set(RANDOM_WORDS).size).toBe(1024);
  });

  it('has only short words of plain lowercase letters, so a person can type them on a phone', () => {
    for (const word of RANDOM_WORDS) expect(word).toMatch(/^[a-z]{3,8}$/);
  });
});

describe('randomWords', () => {
  it('joins three words with hyphens', () => {
    const picks = [0, 1, 1023];
    expect(randomWords(() => picks.shift()!)).toBe(`${RANDOM_WORDS[0]}-${RANDOM_WORDS[1]}-${RANDOM_WORDS[1023]}`);
  });

  it('asks the random source for a word of the full list each time', () => {
    const limits: number[] = [];
    randomWords(limit => { limits.push(limit); return 0; });
    expect(limits).toEqual([1024, 1024, 1024]);
  });

  it('makes a name that ntfy accepts as a topic, with the random source of the browser', () => {
    const name = randomWords();
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('gives a new name each time', () => {
    const names = new Set(Array.from({ length: 20 }, () => randomWords()));
    expect(names.size).toBeGreaterThan(1);
  });
});
