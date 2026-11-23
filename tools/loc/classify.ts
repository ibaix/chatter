// Puts each changed line in one part of the table. The first rule that matches wins:
// 1. Not counted: binary, lock, build output, SVG and generated files
// 2. Tests: test files, test folders, testSupport.ts and the vitest setup files (also their comments)
// 3. Docs: docs/ and each .md file
// 4. Source: comment lines go to "Docs and comments", each other line (also a blank line) to "Application code"
import type { FileHunks, FileStat } from './diff';

export type Part = 'code' | 'tests' | 'docs' | 'notCounted';

export type PathClass = { part: 'notCounted'; reason: string } | { part: 'tests' | 'docs' | 'source' };

export interface LineCount {
  added: number;
  removed: number;
}

export interface FileCount {
  path: string;
  oldPath?: string;
  parts: Partial<Record<Part, LineCount>>;
  /** Why the file is not counted */
  reason?: string;
}

/** The comment lines of the file in the head (for added lines) and in the base (for removed lines) */
export interface FileComments {
  head: Set<number>;
  base: Set<number>;
}

/** The `setupFiles` of the vitest configs. A test in classify.test.ts finds a new one. */
const SETUP_FILES = new Set(['apps/server/src/logging/quietLogsInTests.ts']);

function notCountedReason(path: string, { binary, generated }: { binary: boolean; generated: boolean }): string | undefined {
  if (binary) return 'binary';
  if (/(^|\/)package-lock\.json$/.test(path)) return 'package-lock.json';
  if (/(^|\/)dist\//.test(path) || path.startsWith('coverage/') || path.startsWith('docs/.vitepress/cache/')) return 'build output';
  if (/\.svg$/i.test(path)) return 'SVG';
  if (generated) return 'generated';
  return undefined;
}

function isTest(path: string): boolean {
  return (
    /\.test\.(ts|tsx|sh)$/.test(path) || /(^|\/)test\//.test(path) || /(^|\/)testSupport\.ts$/.test(path) || SETUP_FILES.has(path)
  );
}

/** The part of a file from its path. `generated`: git check-attr marks the file linguist-generated. */
export function classifyPath(path: string, flags: { binary: boolean; generated: boolean }): PathClass {
  const reason = notCountedReason(path, flags);
  if (reason) return { part: 'notCounted', reason };
  if (isTest(path)) return { part: 'tests' };
  if (path.startsWith('docs/') || /\.md$/i.test(path)) return { part: 'docs' };
  return { part: 'source' };
}

function linesIn(lines: number[] | undefined, comments: Set<number> | undefined): number {
  return lines && comments ? lines.filter(line => comments.has(line)).length : 0;
}

/**
 * The lines of one file in each part. The total is always the numstat count of the file,
 * so the rows of the table add up to `git diff --numstat`.
 */
export function countFile(stat: FileStat, hunks: FileHunks | undefined, pathClass: PathClass, comments?: FileComments): FileCount {
  const file: FileCount = { path: stat.path, ...(stat.oldPath ? { oldPath: stat.oldPath } : {}), parts: {} };
  const total = { added: stat.added, removed: stat.removed };
  if (pathClass.part !== 'source') {
    file.parts[pathClass.part] = total;
    if (pathClass.part === 'notCounted') file.reason = pathClass.reason;
    return file;
  }
  const docs = { added: linesIn(hunks?.added, comments?.head), removed: linesIn(hunks?.removed, comments?.base) };
  const code = { added: total.added - docs.added, removed: total.removed - docs.removed };
  const hasDocs = docs.added + docs.removed > 0;
  if (code.added + code.removed > 0 || !hasDocs) file.parts.code = code;
  if (hasDocs) file.parts.docs = docs;
  return file;
}
