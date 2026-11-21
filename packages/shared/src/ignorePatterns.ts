/**
 * Ignore patterns: a channel does not send a message when its text matches one of the patterns of the channel.
 * A pattern matches any part of the text, and it is not case-sensitive. `*` is any run of characters, and `?` is one character.
 * All other characters are plain text, also the signs of a regular expression.
 *
 * The match uses no regular expression. It goes through the text one time, and it goes back only to the last `*`,
 * so a pattern such as `*a*a*a*b` cannot stop a Pi for a long time.
 */

/** A channel can have at most this many patterns */
export const MAX_IGNORE_PATTERNS = 20;
/** A pattern can have at most this many characters */
export const MAX_IGNORE_PATTERN_LENGTH = 100;

const MATCHES_ALL = 'This pattern matches each message. To stop all messages, turn the channel off.';

/** Counts the steps of a match, so a test can check the worst case without a clock */
export interface MatchSteps {
  steps: number;
}

/** True when the pattern matches a part of the text. `counter` gets the number of steps. */
export function matchesPattern(pattern: string, text: string, counter?: MatchSteps): boolean {
  return wildcardMatch(charactersOf(`*${pattern}*`), charactersOf(text), counter);
}

/** The first pattern that matches the text, or null */
export function firstMatchingPattern(patterns: readonly string[], text: string): string | null {
  return patterns.find(pattern => matchesPattern(pattern, text)) ?? null;
}

/** Why Chatter cannot keep the pattern, in plain words, or null when the pattern is good */
export function patternProblem(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === '') return 'A pattern cannot be empty';
  if (trimmed.length > MAX_IGNORE_PATTERN_LENGTH) return `A pattern can have at most ${MAX_IGNORE_PATTERN_LENGTH} characters`;
  if (/^[*?]+$/.test(trimmed)) return MATCHES_ALL;
  return null;
}

/** One entry for each character, so `?` is one emoji too. Lowercase, so the match is not case-sensitive. */
function charactersOf(text: string): string[] {
  return Array.from(text.toLowerCase());
}

/**
 * Matches the whole text. On a mismatch after a `*`, the `*` takes one more character, and the match goes on from there.
 * An earlier `*` never needs to take more: the last `*` can take any run that it could take. So the time is at most
 * the length of the pattern times the length of the text.
 */
function wildcardMatch(pattern: string[], text: string[], counter?: MatchSteps): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let textAtStar = 0;
  while (t < text.length) {
    if (counter) counter.steps++;
    if (p < pattern.length && (pattern[p] === '?' || (pattern[p] !== '*' && pattern[p] === text[t]))) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      starAt = p++;
      textAtStar = t;
    } else if (starAt >= 0) {
      p = starAt + 1;
      t = ++textAtStar;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
