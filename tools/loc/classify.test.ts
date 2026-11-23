import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyPath, countFile } from './classify';

const PLAIN = { binary: false, generated: false };

describe('classifyPath', () => {
  it.each([
    ['package-lock.json', 'package-lock.json'],
    ['docs/package-lock.json', 'package-lock.json'],
    ['packages/shared/dist/index.js', 'build output'],
    ['coverage/lcov.info', 'build output'],
    ['docs/.vitepress/cache/deps/x.js', 'build output'],
    ['docs/public/logo.svg', 'SVG'],
  ])('does not count %s (%s)', (path, reason) => {
    expect(classifyPath(path, PLAIN)).toEqual({ part: 'notCounted', reason });
  });

  it('does not count a binary file or a generated file', () => {
    expect(classifyPath('docs/public/a.png', { binary: true, generated: false })).toEqual({ part: 'notCounted', reason: 'binary' });
    expect(classifyPath('apps/server/src/gen.ts', { binary: false, generated: true })).toEqual({
      part: 'notCounted',
      reason: 'generated',
    });
  });

  it.each([
    'apps/server/src/a.test.ts',
    'apps/web/src/A.test.tsx',
    'tools/pi-image/test/build-version.test.sh',
    'tools/pi-image/test/update-chatter.lib.sh',
    'apps/web/src/test/setup.ts',
    'apps/server/src/logging/testSupport.ts',
    'apps/server/src/notifications/channels/testSupport.ts',
    'apps/server/src/logging/quietLogsInTests.ts',
  ])('counts %s as tests', path => {
    expect(classifyPath(path, PLAIN)).toEqual({ part: 'tests' });
  });

  it.each(['docs/guide/fanuc.md', 'docs/.vitepress/config.mts', 'AGENTS.md', '.agents/skills/x/SKILL.md', 'tools/quality/README.md'])(
    'counts %s as docs',
    path => {
      expect(classifyPath(path, PLAIN)).toEqual({ part: 'docs' });
    },
  );

  it.each(['apps/server/src/app.ts', 'apps/web/src/App.tsx', 'package.json', 'Dockerfile', 'apps/server/src/contest.ts', 'tools/latest/x.ts'])(
    'counts %s as source',
    path => {
      expect(classifyPath(path, PLAIN)).toEqual({ part: 'source' });
    },
  );

  it('counts each test file and each vitest setup file of the repo as tests', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const setupFiles = files
      .filter(f => /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(f))
      .flatMap(config => {
        const match = /setupFiles:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(readFileSync(join(root, config), 'utf8'));
        const entries = match ? [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]) : [];
        return entries.map(entry => posix.normalize(posix.join(posix.dirname(config), entry)));
      });
    const testFiles = files.filter(f => /\.test\./.test(f));

    expect(setupFiles).toContain('apps/server/src/logging/quietLogsInTests.ts');
    expect(testFiles.length).toBeGreaterThan(100);
    const notTests = [...testFiles, ...setupFiles].filter(f => classifyPath(f, PLAIN).part !== 'tests');
    expect(notTests).toEqual([]);
  });
});

describe('countFile', () => {
  const stat = { path: 'a.ts', added: 4, removed: 2, binary: false };
  const hunks = { added: [1, 2, 3, 4], removed: [7, 8] };

  it('puts all lines of a test, docs or not-counted file in its part', () => {
    expect(countFile(stat, hunks, { part: 'tests' })).toEqual({ path: 'a.ts', parts: { tests: { added: 4, removed: 2 } } });
    expect(countFile(stat, hunks, { part: 'docs' })).toEqual({ path: 'a.ts', parts: { docs: { added: 4, removed: 2 } } });
    expect(countFile(stat, hunks, { part: 'notCounted', reason: 'SVG' })).toEqual({
      path: 'a.ts',
      parts: { notCounted: { added: 4, removed: 2 } },
      reason: 'SVG',
    });
  });

  it('splits the lines of a source file into code and comments, with the head lines for added and the base lines for removed', () => {
    const comments = { head: new Set([2, 3, 9]), base: new Set([8]) };

    expect(countFile(stat, hunks, { part: 'source' }, comments)).toEqual({
      path: 'a.ts',
      parts: { code: { added: 2, removed: 1 }, docs: { added: 2, removed: 1 } },
    });
  });

  it('keeps the old path of a renamed file, and gives a code part with 0 lines to a pure rename', () => {
    expect(countFile({ path: 'b.ts', oldPath: 'a.ts', added: 0, removed: 0, binary: false }, undefined, { part: 'source' })).toEqual({
      path: 'b.ts',
      oldPath: 'a.ts',
      parts: { code: { added: 0, removed: 0 } },
    });
  });
});
