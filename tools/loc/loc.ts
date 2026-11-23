// Counts the lines that the commits of a branch add and remove, in four parts:
// application code, tests, docs and comments, and files that we do not count.
// It compares the head with the merge base of the base and the head, as a pull request does.
import { execFileSync } from 'node:child_process';
import { classifyPath, countFile, type FileComments } from './classify';
import { commentLines, languageOf } from './comments';
import { parseHunks, parseNumstat, parseSymlinks, type FileStat } from './diff';
import { filesTable, sizeTable, totalsOf } from './table';

export interface LocArgs {
  base: string;
  head: string;
  json: boolean;
  files: boolean;
}

export interface LocResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const USAGE = 'Use: npm run loc -- [--base <git ref>] [--head <git ref>] [--json] [--files]';

function refAfter(args: string[], index: number, flag: string): string {
  const ref = args[index + 1];
  if (!ref || ref.startsWith('--')) throw new Error(`Give a git ref after ${flag}, for example: ${flag} main`);
  return ref;
}

export function argsFrom(args: string[]): LocArgs {
  const result: LocArgs = { base: 'origin/main', head: 'HEAD', json: false, files: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base' || arg === '--head') {
      result[arg === '--base' ? 'base' : 'head'] = refAfter(args, i, arg);
      i++;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--files') {
      result.files = true;
    } else {
      throw new Error(`Unknown option: ${arg}. ${USAGE}`);
    }
  }
  return result;
}

// The options make the output the same with each git config: the same diff algorithm, rename limit and file order,
// no colors, no external diff tools, paths not quoted
const DIFF = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  '--find-renames',
  '-l1000',
  '-O/dev/null',
];

function gitIn(cwd: string) {
  return (args: string[], input?: string) =>
    execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** The files that .gitattributes marks linguist-generated, as git sees them in the head */
function generatedFiles(git: ReturnType<typeof gitIn>, head: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const input = paths.join('\0') + '\0';
  // The attributes file of the user does not count. (.git/info/attributes still counts.)
  const checkAttr = ['-c', 'core.attributesFile=/dev/null', 'check-attr'];
  let output: string;
  try {
    output = git([...checkAttr, '--source', head, '-z', '--stdin', 'linguist-generated'], input);
  } catch {
    // git before 2.40 has no --source. Then the attributes of the working tree count.
    output = git([...checkAttr, '-z', '--stdin', 'linguist-generated'], input);
  }
  const fields = output.split('\0');
  const generated = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === 'set' || fields[i + 2] === 'true') generated.add(fields[i]);
  }
  return generated;
}

/**
 * Reads many files from git with one process. The key is "<commit>:<path>".
 * A name that is not a file (a folder, a submodule, a missing path) or that has a new line gets no entry.
 */
export function readBlobs(cwd: string, names: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  // One name on each line of the input: a new line in a name would break the order of the output
  const safe = names.filter(name => !name.includes('\n'));
  if (safe.length === 0) return blobs;
  const output = execFileSync('git', ['cat-file', '--batch'], { cwd, input: safe.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  let offset = 0;
  for (const name of safe) {
    const lineEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, lineEnd).toString('utf8');
    offset = lineEnd + 1;
    // "<sha> <type> <size>", then the body and a new line. "<name> missing" has no body.
    const match = / (\w+) (\d+)$/.exec(header);
    if (!match) continue;
    const size = Number(match[2]);
    if (match[1] === 'blob') blobs.set(name, output.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  return blobs;
}

function count(cwd: string, mergeBase: string, headSha: string) {
  const git = gitIn(cwd);
  const stats = parseNumstat(git([...DIFF, '--numstat', '-z', mergeBase, headSha]));
  const hunks = parseHunks(git([...DIFF, '--unified=0', mergeBase, headSha]));
  const symlinks = parseSymlinks(git([...DIFF, '--raw', '-z', mergeBase, headSha]));
  const generated = generatedFiles(git, headSha, stats.map(stat => stat.path));
  const classes = stats.map(stat =>
    classifyPath(stat.path, { binary: stat.binary, generated: generated.has(stat.path), symlink: symlinks.has(stat.path) }),
  );

  // Source files with comments: read the head version for the added lines and the base version for the removed lines
  const withComments = (stat: FileStat, index: number) => classes[index].part === 'source' && languageOf(stat.path) !== 'none';
  const headName = (stat: FileStat) => `${headSha}:${stat.path}`;
  const baseName = (stat: FileStat) => `${mergeBase}:${stat.oldPath ?? stat.path}`;
  const names = stats.flatMap((stat, index) =>
    withComments(stat, index) ? [...(stat.added ? [headName(stat)] : []), ...(stat.removed ? [baseName(stat)] : [])] : [],
  );
  const blobs = readBlobs(cwd, names);
  const commentsOf = (stat: FileStat, index: number): FileComments | undefined => {
    if (!withComments(stat, index)) return undefined;
    const head = blobs.get(headName(stat));
    const base = blobs.get(baseName(stat));
    return {
      head: head === undefined ? new Set() : commentLines(head, stat.path),
      base: base === undefined ? new Set() : commentLines(base, stat.oldPath ?? stat.path),
    };
  };

  return stats.map((stat, index) => countFile(stat, hunks.get(stat.path), classes[index], commentsOf(stat, index)));
}

export function runLoc(argv: string[], cwd: string): LocResult {
  let args: LocArgs;
  try {
    args = argsFrom(argv);
  } catch (error) {
    return { stdout: '', stderr: `${(error as Error).message}\n`, exitCode: 2 };
  }
  const git = gitIn(cwd);

  let mergeBase: string;
  let headSha: string;
  try {
    headSha = git(['rev-parse', '--verify', '--quiet', `${args.head}^{commit}`]).trim();
    mergeBase = git(['merge-base', args.base, headSha]).trim();
  } catch {
    return {
      stdout: '',
      stderr: `Cannot find the base ${args.base} or the head ${args.head}. Run git fetch origin, or give --base <ref>.\n`,
      exitCode: 2,
    };
  }

  let stderr = '';
  if (args.head === 'HEAD' && git(['status', '--porcelain']).trim() !== '') {
    stderr = 'Note: the table counts the commits only. Changes that are not committed are not in it.\n';
  }

  const files = count(cwd, mergeBase, headSha);
  const totals = totalsOf(files);
  // A fixed length: `--short` changes with core.abbrev and with the size of the repo
  const short = (sha: string) => sha.slice(0, 8);

  if (args.json) {
    const json = { base: { ref: args.base, sha: mergeBase }, head: { ref: args.head, sha: headSha }, ...totals, files };
    return { stdout: `${JSON.stringify(json, null, 2)}\n`, stderr, exitCode: 0 };
  }
  const refs = { base: args.base, baseSha: short(mergeBase), head: args.head, headSha: short(headSha) };
  const tables = [sizeTable(totals, refs), ...(args.files ? [filesTable(files)] : [])];
  return { stdout: `${tables.join('\n\n')}\n`, stderr, exitCode: 0 };
}
