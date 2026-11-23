import { describe, expect, it } from 'vitest';
import { parseHunks, parseNumstat } from './diff';

describe('parseNumstat', () => {
  it('reads the counts and the path of each file', () => {
    const z = ['3\t1\tapps/server/src/a.ts', '0\t12\tdocs/gone.md', '5\t0\tmy file é.ts', ''].join('\0');

    expect(parseNumstat(z)).toEqual([
      { path: 'apps/server/src/a.ts', added: 3, removed: 1, binary: false },
      { path: 'docs/gone.md', added: 0, removed: 12, binary: false },
      { path: 'my file é.ts', added: 5, removed: 0, binary: false },
    ]);
  });

  it('reads a binary file as 0 lines', () => {
    expect(parseNumstat('-\t-\tdocs/public/a.png\0')).toEqual([{ path: 'docs/public/a.png', added: 0, removed: 0, binary: true }]);
  });

  it('reads the old and the new path of a renamed file', () => {
    const z = ['0\t0\t', 'old.ts', 'new.ts', '2\t1\t', 'a/b.ts', 'a/c.ts', '1\t0\tafter.ts', ''].join('\0');

    expect(parseNumstat(z)).toEqual([
      { path: 'new.ts', oldPath: 'old.ts', added: 0, removed: 0, binary: false },
      { path: 'a/c.ts', oldPath: 'a/b.ts', added: 2, removed: 1, binary: false },
      { path: 'after.ts', added: 1, removed: 0, binary: false },
    ]);
  });

  it('gives an empty list for an empty diff', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('parseHunks', () => {
  it('reads the added lines (head numbers) and the removed lines (base numbers) of each file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3 +3,2 @@ function start() {',
      '-old',
      '+new one',
      '+new two',
      '@@ -10,2 +12,0 @@',
      '-gone',
      '-gone too',
      '@@ -20,0 +21 @@',
      '+added',
    ].join('\n');

    expect(parseHunks(diff)).toEqual(new Map([['a.ts', { added: [3, 4, 21], removed: [3, 10, 11] }]]));
  });

  it('reads a new file and a deleted file', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n');

    expect(parseHunks(diff)).toEqual(
      new Map([
        ['new.ts', { added: [1, 2], removed: [] }],
        ['gone.ts', { added: [], removed: [1, 2, 3] }],
      ]),
    );
  });

  it('keys a renamed and changed file by its new path, and skips a pure rename, a mode change and a binary file', () => {
    const diff = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/a.png b/a.png',
      'index 1111111..2222222 100644',
      'Binary files a/a.png and b/a.png differ',
      'diff --git a/x.ts b/y.ts',
      'similarity index 80%',
      'rename from x.ts',
      'rename to y.ts',
      'index 1111111..2222222 100644',
      '--- a/x.ts',
      '+++ b/y.ts',
      '@@ -2 +2 @@',
      '-b',
      '+c',
    ].join('\n');

    expect(parseHunks(diff)).toEqual(new Map([['y.ts', { added: [2], removed: [2] }]]));
  });

  it('skips the "No newline at end of file" lines', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-x',
      '\\ No newline at end of file',
      '+y',
      '\\ No newline at end of file',
    ].join('\n');

    expect(parseHunks(diff)).toEqual(new Map([['a.txt', { added: [1], removed: [1] }]]));
  });

  it('reads a path with spaces and Unicode (git puts a tab after it)', () => {
    const diff = [
      'diff --git a/my file é.ts b/my file é.ts',
      '--- a/my file é.ts\t',
      '+++ b/my file é.ts\t',
      '@@ -2 +2 @@ a',
      '-b',
      '+c',
    ].join('\n');

    expect(parseHunks(diff)).toEqual(new Map([['my file é.ts', { added: [2], removed: [2] }]]));
  });

  it('reads a path that git puts in quotes', () => {
    const diff = ['diff --git "a/tab\\there.ts" "b/tab\\there.ts"', '--- "a/tab\\there.ts"', '+++ "b/tab\\there.ts"', '@@ -0,0 +1 @@', '+a'].join(
      '\n',
    );

    expect(parseHunks(diff)).toEqual(new Map([['tab\there.ts', { added: [1], removed: [] }]]));
  });

  it('reads removed and added lines that look like file headers as lines', () => {
    const diff = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1 +1 @@', '--- a/x', '+++ b/y'].join('\n');

    expect(parseHunks(diff)).toEqual(new Map([['a.md', { added: [1], removed: [1] }]]));
  });
});
