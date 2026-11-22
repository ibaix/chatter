// The update helper on the Pi writes a step in status.json, and Chatter shows a text for each step.
// The helper is bash and Chatter is TypeScript, so each has its own copy of the list. This test keeps them the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPDATE_STEPS } from '@local-chatter/shared';
import { describe, expect, it } from 'vitest';

const HELPER = join(import.meta.dirname, '../../tools/pi-image/in-pi/update-chatter.sh');

/** Reads the words of the one line `STEPS=(...)` in a bash script */
function bashSteps(script: string): string[] {
  const lines = [...script.matchAll(/^STEPS=\(([^)]*)\)$/gm)];
  if (lines.length !== 1) throw new Error(`expected one STEPS=(...) line, found ${lines.length}`);
  return lines[0][1].trim().split(/\s+/);
}

describe('the steps of the update helper', () => {
  it('are UPDATE_STEPS of packages/shared, in the same order (STEPS in update-chatter.sh)', () => {
    expect(bashSteps(readFileSync(HELPER, 'utf8'))).toEqual([...UPDATE_STEPS]);
  });

  it('are read from the one STEPS line only', () => {
    expect(bashSteps('# STEPS=(a b)\nSTEPS=(copying  listing)\nOTHER_STEPS=(x)\n')).toEqual(['copying', 'listing']);
    expect(() => bashSteps('steps=(a b)\n')).toThrow('found 0');
  });
});
