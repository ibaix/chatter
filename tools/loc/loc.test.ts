import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { argsFrom, readBlobs, runLoc } from './loc';

let repo: string;
let outside: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function write(path: string, content: string | Buffer) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** The first 8 characters of the sha of a ref in the temp repo */
const short = (ref: string) => git('rev-parse', ref).slice(0, 8);

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  // A git hook sets these variables. Then git would act on the real repo, not on the temp repo.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) {
    vi.stubEnv(name, undefined);
  }
  outside = mkdtempSync(join(tmpdir(), 'chatter-loc-config-'));
  repo = mkdtempSync(join(tmpdir(), 'chatter-loc-'));
  git('init', '-q', '-b', 'main');
  write('.gitattributes', 'gen/** linguist-generated=true\n');
  write('src/app.ts', ['// The app', '// Old note', 'export const a = 1;', 'export const b = 2;', ''].join('\n'));
  write('src/util.ts', 'export const u = 1;\n');
  write('src/old.ts', ['// note', 'export const o1 = 1;', 'export const o2 = 2;', 'export const o3 = 3;', 'export const o4 = 4;', ''].join('\n'));
  // The patience diff gives other added and removed lines for this file than the myers diff
  write('src/order.ts', ['// c', '// c', '', '// c', 'a();', 'a();', 'a();', ''].join('\n'));
  write('README.md', ['# App', 'Old text.', ''].join('\n'));
  write('package-lock.json', ['{', '  "v": 1', '}', ''].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'start');

  git('checkout', '-q', '-b', 'feature');
  write('.gitattributes', 'gen/** linguist-generated=true\ngen2/** linguist-generated\n');
  write('src/app.ts', ['// The app', 'export const a = 1;', '/** New value */', 'export const c = 3;', '', 'export const d = 4;', ''].join('\n'));
  write('src/app.test.ts', ["import { c } from './app';", '// c is 3', 'if (c !== 3) throw new Error();', ''].join('\n'));
  write('src/order.ts', ['a();', '// c', 'a();', 'a();', '// c', '// c', '', ''].join('\n'));
  write('src/é.ts', ['// é', 'export const e = 1;', ''].join('\n'));
  write('README.md', ['# App', 'New text.', 'More text.', ''].join('\n'));
  write('package-lock.json', ['{', '  "v": 2,', '  "a": 1,', '  "b": 2', '}', ''].join('\n'));
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x00, 0x02]));
  write('gen/out.ts', 'export const g = 1;\nexport const h = 2;\n');
  write('gen2/out.ts', 'export const g2 = 1;\n');
  symlinkSync('src/app.ts', join(repo, 'link'));
  git('mv', 'src/util.ts', 'src/helpers.ts');
  // A rename that also removes the comment line
  git('mv', 'src/old.ts', 'src/new.ts');
  write('src/new.ts', ['export const o1 = 1;', 'export const o2 = 2;', 'export const o3 = 3;', 'export const o4 = 4;', ''].join('\n'));
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
  rmSync(outside, { recursive: true, force: true });
});

describe('runLoc', () => {
  it('prints the size table of the commits of a branch, compared with the merge base', () => {
    const result = runLoc(['--base', 'main'], repo);

    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: [
        `Base: main (${short('main~1')}), head: HEAD (${short('HEAD')})`,
        '',
        '| Part | Added | Removed |',
        '|---|---:|---:|',
        '| Application code | +6 | -2 |',
        '| Tests | +3 | -0 |',
        '| Docs and comments | +7 | -6 |',
        '| Not counted (2 generated files; symlink; 1 binary file; package-lock.json) | +7 | -1 |',
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
    expect(stdout).toContain('| src/old.ts → src/new.ts | Docs and comments | +0 | -1 |');
    expect(stdout).toContain('| src/é.ts | Docs and comments | +1 | -0 |');
    expect(stdout).toContain('| link | Not counted (symlink) | +1 | -0 |');
    expect(stdout).toContain('| logo.png | Not counted (binary) | +0 | -0 |');
  });

  it('gives the same text when the git config of the user changes the diff, the paths, the order or the attributes', () => {
    const orderFile = join(outside, 'order');
    writeFileSync(orderFile, 'src/*\n*\n');
    const attributesFile = join(outside, 'attributes');
    writeFileSync(attributesFile, '*.ts linguist-generated\n');
    const hostile = {
      'diff.algorithm': 'patience',
      'diff.renames': 'false',
      'diff.renameLimit': '1',
      'diff.noprefix': 'true',
      'diff.mnemonicPrefix': 'true',
      'diff.orderFile': orderFile,
      'color.ui': 'always',
      'color.diff': 'always',
      'core.quotePath': 'true',
      'core.abbrev': '12',
      'core.attributesFile': attributesFile,
    };
    const expected = runLoc(['--base', 'main', '--files'], repo);

    vi.stubEnv('GIT_CONFIG_COUNT', String(Object.keys(hostile).length));
    Object.entries(hostile).forEach(([key, value], index) => {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value);
    });
    try {
      expect(runLoc(['--base', 'main', '--files'], repo)).toEqual(expected);
    } finally {
      vi.stubEnv('GIT_CONFIG_COUNT', '0');
    }
  });

  it('reads the generated files from the .gitattributes of the head, not of the working tree', () => {
    git('checkout', '-q', 'main');
    try {
      expect(runLoc(['--base', 'main', '--head', 'feature', '--files'], repo).stdout).toContain(
        '| gen2/out.ts | Not counted (generated) | +1 | -0 |',
      );
    } finally {
      git('checkout', '-q', 'feature');
    }
  });

  it('gives zeros and no "Not counted" row when the head has no commits after the base', () => {
    const { stdout, exitCode } = runLoc(['--base', 'feature'], repo);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('| Application code | +0 | -0 |');
    expect(stdout).not.toContain('Not counted');
  });

  it('counts a head that is not checked out', () => {
    expect(runLoc(['--base', 'feature', '--head', 'main'], repo).stdout).toContain('| Application code | +1 | -0 |');
  });

  it('warns that changes that are not committed do not count, only when the head is HEAD', () => {
    write('src/app.ts', 'changed\n');
    try {
      const { stderr, stdout } = runLoc(['--base', 'main'], repo);
      expect(stderr).toBe('Note: the table counts the commits only. Changes that are not committed are not in it.\n');
      expect(stdout).toContain('| Application code | +6 | -2 |');
      expect(runLoc(['--base', 'feature', '--head', 'main'], repo).stderr).toBe('');
    } finally {
      git('checkout', '--', 'src/app.ts');
    }
  });

  it('exits with 2 and tells what to do when the base does not exist', () => {
    const result = runLoc(['--base', 'origin/nothing'], repo);

    expect(result).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'Cannot find the base origin/nothing or the head HEAD. Run git fetch origin, or give --base <ref>.\n',
    });
  });

  it('exits with 2 and shows the usage on an unknown option', () => {
    expect(runLoc(['--bse', 'main'], repo)).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'Unknown option: --bse. Use: npm run loc -- [--base <git ref>] [--head <git ref>] [--json] [--files]\n',
    });
  });
});

describe('readBlobs', () => {
  it('reads the files, and skips a folder, a missing file and a name with a new line', () => {
    const blobs = readBlobs(repo, ['HEAD:src', 'HEAD:README.md', 'HEAD:nothing.ts', 'HEAD:a\nb', 'HEAD:src/helpers.ts']);

    expect(blobs).toEqual(
      new Map([
        ['HEAD:README.md', '# App\nNew text.\nMore text.\n'],
        ['HEAD:src/helpers.ts', 'export const u = 1;\n'],
      ]),
    );
  });
});

describe('argsFrom', () => {
  it('uses origin/main and HEAD when no ref is given', () => {
    expect(argsFrom([])).toEqual({ base: 'origin/main', head: 'HEAD', json: false, files: false });
  });

  it('reads each option', () => {
    expect(argsFrom(['--head', 'x', '--json', '--base', 'main', '--files'])).toEqual({ base: 'main', head: 'x', json: true, files: true });
  });

  it.each([
    [['--base'], 'Give a git ref after --base, for example: --base main'],
    [['--base', '--json'], 'Give a git ref after --base, for example: --base main'],
    [['--head'], 'Give a git ref after --head, for example: --head main'],
    [['--what'], 'Unknown option: --what.'],
  ])('refuses %j', (args, message) => {
    expect(() => argsFrom(args)).toThrow(message);
  });
});
