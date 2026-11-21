import { describe, expect, it } from 'vitest';
import {
  areaOf,
  areaTable,
  baseFrom,
  changeTable,
  changedLineCoverage,
  changedLinesFromDiff,
  coverageByArea,
  lineHitsFromLcov,
  toRanges,
  type CoverageSummary,
} from './coverage';

const ROOT = '/repo';

describe('areaOf', () => {
  it('gives the workspace or tool folder of a file', () => {
    expect(areaOf('apps/server/src/app.ts')).toBe('apps/server');
    expect(areaOf('packages/shared/src/index.ts')).toBe('packages/shared');
    expect(areaOf('tools/fake-machines/tcp.ts')).toBe('tools/fake-machines');
  });
});

describe('coverageByArea', () => {
  const counts = (covered: number, total: number) => ({ total, covered, skipped: 0, pct: (100 * covered) / total });
  const file = (lines: [number, number], branches: [number, number]) => ({
    lines: counts(...lines),
    statements: counts(...lines),
    functions: counts(1, 1),
    branches: counts(...branches),
  });

  it('adds the counts of the files in each area, and keeps the total last', () => {
    const summary: CoverageSummary = {
      total: file([7, 11], [3, 6]),
      '/repo/apps/server/src/a.ts': file([3, 4], [1, 2]),
      '/repo/apps/server/src/b.ts': file([1, 4], [1, 2]),
      '/repo/apps/web/src/c.tsx': file([3, 3], [1, 2]),
    };

    expect(coverageByArea(summary, ROOT)).toEqual([
      { area: 'apps/server', lines: { covered: 4, total: 8 }, branches: { covered: 2, total: 4 } },
      { area: 'apps/web', lines: { covered: 3, total: 3 }, branches: { covered: 1, total: 2 } },
      { area: 'total', lines: { covered: 7, total: 11 }, branches: { covered: 3, total: 6 } },
    ]);
  });
});

describe('lineHitsFromLcov', () => {
  it('reads the hit count of each line, with the path from the repo root', () => {
    const lcov = [
      'TN:',
      'SF:/repo/apps/server/src/a.ts',
      'FN:1,start',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      'SF:/repo/tools/quality/b.ts',
      'DA:5,3',
      'end_of_record',
    ].join('\n');

    const hits = lineHitsFromLcov(lcov, ROOT);

    expect(hits.get('apps/server/src/a.ts')).toEqual(new Map([[1, 1], [2, 0]]));
    expect(hits.get('tools/quality/b.ts')).toEqual(new Map([[5, 3]]));
  });
});

describe('changedLinesFromDiff', () => {
  it('reads the added and changed lines of each file from a diff with no context', () => {
    const diff = [
      'diff --git a/apps/server/src/a.ts b/apps/server/src/a.ts',
      '--- a/apps/server/src/a.ts',
      '+++ b/apps/server/src/a.ts',
      '@@ -3 +3,2 @@ function start() {',
      '-old',
      '+new one',
      '+new two',
      '@@ -10,0 +12 @@',
      '+added',
      'diff --git a/docs/x.md b/docs/x.md',
      '--- a/docs/x.md',
      '+++ b/docs/x.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    expect(changedLinesFromDiff(diff)).toEqual(
      new Map([
        ['apps/server/src/a.ts', [3, 4, 12]],
        ['docs/x.md', [1]],
      ]),
    );
  });

  it('skips a deleted file and a hunk that only removes lines', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      'diff --git a/kept.ts b/kept.ts',
      '--- a/kept.ts',
      '+++ b/kept.ts',
      '@@ -4,2 +3,0 @@',
      '-a',
      '-b',
    ].join('\n');

    expect(changedLinesFromDiff(diff)).toEqual(new Map());
  });
});

describe('toRanges', () => {
  it('joins lines that follow each other', () => {
    expect(toRanges([1, 2, 3, 7, 9, 10])).toEqual(['1-3', '7', '9-10']);
    expect(toRanges([])).toEqual([]);
  });
});

describe('changedLineCoverage', () => {
  const hits = new Map([
    ['apps/server/src/a.ts', new Map([[1, 1], [2, 0], [3, 0], [5, 2]])],
    ['apps/web/src/b.tsx', new Map([[8, 4]])],
  ]);

  it('counts only the changed lines that the coverage tool can measure', () => {
    const changed = new Map([
      // Line 4 is a comment or a type, so the coverage has no count for it
      ['apps/server/src/a.ts', [2, 3, 4, 5]],
      ['apps/web/src/b.tsx', [8]],
    ]);

    expect(changedLineCoverage(changed, hits)).toEqual([
      { file: 'apps/server/src/a.ts', measured: 3, covered: 1, uncovered: ['2-3'] },
      { file: 'apps/web/src/b.tsx', measured: 1, covered: 1, uncovered: [] },
    ]);
  });

  it('leaves out files with no measured lines, such as docs and tests', () => {
    const changed = new Map([
      ['docs/x.md', [1]],
      ['apps/server/src/a.test.ts', [1, 2]],
      ['apps/server/src/a.ts', [4]],
    ]);

    expect(changedLineCoverage(changed, hits)).toEqual([]);
  });
});

describe('the Markdown tables', () => {
  it('shows the percent of each area, and a dash for an area with nothing to measure', () => {
    const table = areaTable([
      { area: 'apps/server', lines: { covered: 885, total: 1000 }, branches: { covered: 0, total: 0 } },
    ]);

    expect(table).toBe(['| Area | Lines | Branches |', '|---|---:|---:|', '| apps/server | 88.5% | – |'].join('\n'));
  });

  it('shows the uncovered changed lines of each file', () => {
    const table = changeTable([
      { file: 'apps/server/src/a.ts', measured: 4, covered: 1, uncovered: ['2-3', '9'] },
    ]);

    expect(table).toBe(
      ['| File | Changed lines covered | Not covered |', '|---|---:|---|', '| apps/server/src/a.ts | 1 of 4 | 2-3, 9 |'].join('\n'),
    );
  });

  it('says so when no changed line can be measured', () => {
    expect(changeTable([])).toBe('No changed line in the coverage report.');
  });
});

describe('baseFrom', () => {
  it('uses origin/main when no base is given', () => {
    expect(baseFrom([])).toBe('origin/main');
  });

  it('reads the ref after --base', () => {
    expect(baseFrom(['--base', 'chore/eslint'])).toBe('chore/eslint');
  });

  it.each([[['--base']], [['--base', '--all']]])('says that %j has no ref after --base', args => {
    expect(() => baseFrom(args)).toThrow('Give a git ref after --base, for example: --base main');
  });
});
