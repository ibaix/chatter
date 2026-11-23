import { describe, expect, it } from 'vitest';
import type { FileCount } from './classify';
import { filesTable, notCountedNote, sizeTable, totalsOf } from './table';

const REFS = { base: 'origin/main', baseSha: '1e128e0', head: 'HEAD', headSha: 'abc1234' };

const FILES: FileCount[] = [
  { path: 'apps/server/src/a.ts', parts: { code: { added: 30, removed: 4 }, docs: { added: 5, removed: 1 } } },
  { path: 'apps/server/src/a.test.ts', parts: { tests: { added: 50, removed: 0 } } },
  { path: 'docs/guide/a.md', parts: { docs: { added: 12, removed: 2 } } },
  { path: 'package-lock.json', parts: { notCounted: { added: 200, removed: 90 } }, reason: 'package-lock.json' },
  { path: 'docs/public/a.png', parts: { notCounted: { added: 0, removed: 0 } }, reason: 'binary' },
  { path: 'docs/public/b.png', parts: { notCounted: { added: 0, removed: 0 } }, reason: 'binary' },
  { path: 'apps/web/src/new.ts', oldPath: 'apps/web/src/old.ts', parts: { code: { added: 0, removed: 0 } } },
];

describe('totalsOf', () => {
  it('adds the lines of each part, and the sum of the parts is the sum of the files', () => {
    const totals = totalsOf(FILES);

    expect(totals.parts).toEqual({
      code: { added: 30, removed: 4 },
      tests: { added: 50, removed: 0 },
      docs: { added: 17, removed: 3 },
      notCounted: { added: 200, removed: 90 },
    });
    const sum = (key: 'added' | 'removed') => Object.values(totals.parts).reduce((total, part) => total + part[key], 0);
    expect(sum('added')).toBe(297);
    expect(sum('removed')).toBe(97);
  });

  it('gives zeros for no files', () => {
    expect(totalsOf([]).parts).toEqual({
      code: { added: 0, removed: 0 },
      tests: { added: 0, removed: 0 },
      docs: { added: 0, removed: 0 },
      notCounted: { added: 0, removed: 0 },
    });
  });
});

describe('notCountedNote', () => {
  it('names each kind of file once, in the order of the files, and counts binary files', () => {
    expect(notCountedNote(['package-lock.json', 'binary', 'binary'])).toBe('package-lock.json; 2 binary files');
    expect(notCountedNote(['binary', 'SVG', 'package-lock.json', 'package-lock.json'])).toBe(
      '1 binary file; SVG; package-lock.json (2 files)',
    );
    expect(notCountedNote([])).toBe('');
  });
});

describe('sizeTable', () => {
  it('prints the refs and the four parts in a fixed order', () => {
    expect(sizeTable(totalsOf(FILES), REFS)).toBe(
      [
        'Base: origin/main (1e128e0), head: HEAD (abc1234)',
        '',
        '| Part | Added | Removed |',
        '|---|---:|---:|',
        '| Application code | +30 | -4 |',
        '| Tests | +50 | -0 |',
        '| Docs and comments | +17 | -3 |',
        '| Not counted (package-lock.json; 2 binary files) | +200 | -90 |',
      ].join('\n'),
    );
  });

  it('prints zeros and no note for an empty change', () => {
    expect(sizeTable(totalsOf([]), REFS).split('\n').slice(4)).toEqual([
      '| Application code | +0 | -0 |',
      '| Tests | +0 | -0 |',
      '| Docs and comments | +0 | -0 |',
      '| Not counted | +0 | -0 |',
    ]);
  });
});

describe('filesTable', () => {
  it('prints one row for each part of each file, and the old path of a renamed file', () => {
    expect(filesTable(FILES.slice(0, 1).concat(FILES.slice(3, 5), FILES.slice(6)))).toBe(
      [
        '| File | Part | Added | Removed |',
        '|---|---|---:|---:|',
        '| apps/server/src/a.ts | Application code | +30 | -4 |',
        '| apps/server/src/a.ts | Docs and comments | +5 | -1 |',
        '| package-lock.json | Not counted (package-lock.json) | +200 | -90 |',
        '| docs/public/a.png | Not counted (binary) | +0 | -0 |',
        '| apps/web/src/old.ts → apps/web/src/new.ts | Application code | +0 | -0 |',
      ].join('\n'),
    );
  });

  it('escapes a | in a path', () => {
    expect(filesTable([{ path: 'a|b.ts', parts: { code: { added: 1, removed: 0 } } }]).split('\n')[2]).toBe(
      '| a\\|b.ts | Application code | +1 | -0 |',
    );
  });
});
