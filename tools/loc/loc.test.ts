import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { argsFrom, runLoc } from './loc';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function write(path: string, content: string | Buffer) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  repo = mkdtempSync(join(tmpdir(), 'chatter-loc-'));
  git('init', '-q', '-b', 'main');
  write('.gitattributes', 'gen/** linguist-generated=true\n');
  write('src/app.ts', ['// The app', '// Old note', 'export const a = 1;', 'export const b = 2;', ''].join('\n'));
  write('src/util.ts', 'export const u = 1;\n');
  write('README.md', ['# App', 'Old text.', ''].join('\n'));
  write('package-lock.json', ['{', '  "v": 1', '}', ''].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'start');

  git('checkout', '-q', '-b', 'feature');
  write('src/app.ts', ['// The app', 'export const a = 1;', '/** New value */', 'export const c = 3;', '', 'export const d = 4;', ''].join('\n'));
  write('src/app.test.ts', ["import { c } from './app';", '// c is 3', 'if (c !== 3) throw new Error();', ''].join('\n'));
  write('README.md', ['# App', 'New text.', 'More text.', ''].join('\n'));
  write('package-lock.json', ['{', '  "v": 2,', '  "a": 1,', '  "b": 2', '}', ''].join('\n'));
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x00, 0x02]));
  write('gen/out.ts', 'export const g = 1;\nexport const h = 2;\n');
  git('mv', 'src/util.ts', 'src/helpers.ts');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');

  // A commit on main after the branch: the merge base keeps it out of the count
  git('checkout', '-q', 'main');
  write('src/later.ts', 'export const later = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'later');
  git('checkout', '-q', 'feature');
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe('runLoc', () => {
  it('prints the size table of the commits of a branch, compared with the merge base', () => {
    const result = runLoc(['--base', 'main'], repo);

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: [
        `Base: main (${git('rev-parse', '--short', 'main~1')}), head: HEAD (${git('rev-parse', '--short', 'HEAD')})`,
        '',
        '| Part | Added | Removed |',
        '|---|---:|---:|',
        '| Application code | +3 | -1 |',
        '| Tests | +3 | -0 |',
        '| Docs and comments | +3 | -2 |',
        '| Not counted (generated; 1 binary file; package-lock.json) | +5 | -1 |',
        '',
      ].join('\n'),
    });
  });

  it('gives the same totals as git diff --numstat', () => {
    const json = JSON.parse(runLoc(['--base', 'main', '--json'], repo).stdout);
    const numstat = git('diff', '--numstat', 'main~1', 'HEAD')
      .split('\n')
      .map(line => line.split('\t'))
      .filter(([added]) => added !== '-');
    const sum = (index: number) => numstat.reduce((total, row) => total + Number(row[index]), 0);

    const parts = Object.values(json.parts) as { added: number; removed: number }[];
    expect(parts.reduce((total, part) => total + part.added, 0)).toBe(sum(0));
    expect(parts.reduce((total, part) => total + part.removed, 0)).toBe(sum(1));
    expect(json.base).toEqual({ ref: 'main', sha: git('rev-parse', 'main~1') });
    expect(json.head).toEqual({ ref: 'HEAD', sha: git('rev-parse', 'HEAD') });
  });

  it('lists each file with --files', () => {
    const { stdout } = runLoc(['--base', 'main', '--files'], repo);

    expect(stdout).toContain('| src/app.ts | Application code | +3 | -1 |');
    expect(stdout).toContain('| src/app.ts | Docs and comments | +1 | -1 |');
    expect(stdout).toContain('| src/util.ts → src/helpers.ts | Application code | +0 | -0 |');
    expect(stdout).toContain('| logo.png | Not counted (binary) | +0 | -0 |');
  });

  it('gives zeros when the head has no commits after the base', () => {
    const { stdout, exitCode } = runLoc(['--base', 'feature'], repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('| Application code | +0 | -0 |');
    expect(stdout).toContain('| Not counted | +0 | -0 |');
  });

  it('counts a head that is not checked out', () => {
    expect(runLoc(['--base', 'feature', '--head', 'main'], repo).stdout).toContain('| Application code | +1 | -0 |');
  });

  it('warns that changes that are not committed do not count', () => {
    write('src/app.ts', 'changed\n');
    try {
      const { stderr, stdout } = runLoc(['--base', 'main'], repo);
      expect(stderr).toMatch(/not committed/);
      expect(stdout).toContain('| Application code | +3 | -1 |');
    } finally {
      git('checkout', '--', 'src/app.ts');
    }
  });

  it('exits with 2 and tells what to do when the base does not exist', () => {
    const result = runLoc(['--base', 'origin/nothing'], repo);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Run git fetch origin, or give --base/);
  });

  it('exits with 2 on an unknown option', () => {
    expect(runLoc(['--bse', 'main'], repo)).toMatchObject({ exitCode: 2, stdout: '' });
  });
});

describe('argsFrom', () => {
  it('uses origin/main and HEAD when no ref is given', () => {
    expect(argsFrom([])).toEqual({ base: 'origin/main', head: 'HEAD', json: false, files: false });
  });

  it('reads each option', () => {
    expect(argsFrom(['--head', 'x', '--json', '--base', 'main', '--files'])).toEqual({ base: 'main', head: 'x', json: true, files: true });
  });

  it.each([[['--base']], [['--base', '--json']], [['--head']], [['--what']]])('refuses %j', args => {
    expect(() => argsFrom(args)).toThrow();
  });
});
