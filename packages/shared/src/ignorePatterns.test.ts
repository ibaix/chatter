import { describe, expect, it } from 'vitest';
import {
  firstMatchingPattern,
  matchesPattern,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  patternProblem,
} from './ignorePatterns.js';

const TEXT = 'WARNING - Haas VF-2: Idle for 20 minutes. Started 9:40 AM.';

describe('matchesPattern', () => {
  it('matches a part of the text', () => {
    expect(matchesPattern('Idle for', TEXT)).toBe(true);
    expect(matchesPattern('In alarm', TEXT)).toBe(false);
  });

  it('is not case-sensitive', () => {
    expect(matchesPattern('haas vf-2', TEXT)).toBe(true);
    expect(matchesPattern('IDLE', 'idle for 20 minutes')).toBe(true);
  });

  it('reads * as any run of characters, also no characters', () => {
    expect(matchesPattern('Haas*Idle', TEXT)).toBe(true);
    expect(matchesPattern('VF-2:*Idle', TEXT)).toBe(true);
    expect(matchesPattern('Idle*Haas', TEXT)).toBe(false);
  });

  it('reads ? as exactly one character', () => {
    expect(matchesPattern('VF-?:', TEXT)).toBe(true);
    expect(matchesPattern('VF-??:', TEXT)).toBe(false);
    expect(matchesPattern('Idle for ?? minutes', TEXT)).toBe(true);
  });

  it('reads the signs of a regular expression as plain text', () => {
    expect(matchesPattern('VF-2.', TEXT)).toBe(false);
    expect(matchesPattern('(test)', 'Spindle (test) run')).toBe(true);
    expect(matchesPattern('(test)', 'Spindle test run')).toBe(false);
    expect(matchesPattern('a+b', 'a+b')).toBe(true);
    expect(matchesPattern('a+b', 'aab')).toBe(false);
    expect(matchesPattern('[0-9]', 'Program 5')).toBe(false);
    expect(matchesPattern('^Start$', 'Start')).toBe(false);
    expect(matchesPattern('\\d', 'a\\d')).toBe(true);
  });

  it('finishes fast for a pattern that is slow with a regular expression', () => {
    const text = 'a'.repeat(20_000);
    const start = performance.now();
    expect(matchesPattern('*a*a*a*a*a*b', text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('firstMatchingPattern', () => {
  it('gives the first pattern that matches, or null', () => {
    expect(firstMatchingPattern(['In alarm', 'idle', 'Haas'], TEXT)).toBe('idle');
    expect(firstMatchingPattern(['In alarm'], TEXT)).toBeNull();
    expect(firstMatchingPattern([], TEXT)).toBeNull();
  });
});

describe('patternProblem', () => {
  it('accepts a normal pattern', () => {
    expect(patternProblem('Idle for*minutes')).toBeNull();
    expect(patternProblem('x'.repeat(MAX_IGNORE_PATTERN_LENGTH))).toBeNull();
  });

  it('refuses an empty pattern', () => {
    expect(patternProblem('')).toMatch(/empty/i);
    expect(patternProblem('   ')).toMatch(/empty/i);
  });

  it('refuses a pattern that is too long', () => {
    expect(patternProblem('x'.repeat(MAX_IGNORE_PATTERN_LENGTH + 1))).toMatch(`${MAX_IGNORE_PATTERN_LENGTH}`);
  });

  it('refuses a pattern that matches each message', () => {
    const problem = 'This pattern matches each message. To stop all messages, turn the channel off.';
    expect(patternProblem('*')).toBe(problem);
    expect(patternProblem('?')).toBe(problem);
    expect(patternProblem('**?*')).toBe(problem);
  });

  it('allows 20 patterns', () => {
    expect(MAX_IGNORE_PATTERNS).toBe(20);
  });
});
