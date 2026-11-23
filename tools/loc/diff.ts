// Reads the output of `git diff --numstat -z` and `git diff --unified=0`.

export interface FileStat {
  /** The path in the head. For a deleted file, the path in the base. */
  path: string;
  /** The path in the base, only for a renamed file */
  oldPath?: string;
  added: number;
  removed: number;
  /** git counts no lines in a binary file */
  binary: boolean;
}

/** The changed lines of one file: added lines as head line numbers, removed lines as base line numbers */
export interface FileHunks {
  added: number[];
  removed: number[];
}

/**
 * `git diff --numstat -z`: "added TAB removed TAB path NUL" for each file.
 * For a rename, the path part is empty, and the old path and the new path follow, each with a NUL.
 */
export function parseNumstat(z: string): FileStat[] {
  const fields = z.split('\0');
  const stats: FileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i]);
    if (!match) continue;
    const [, added, removed, path] = match;
    const binary = added === '-';
    const counts = { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
    if (path === '') {
      stats.push({ path: fields[i + 2], oldPath: fields[i + 1], ...counts });
      i += 2;
    } else {
      stats.push({ path, ...counts });
    }
  }
  return stats;
}

const ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\' };

/** git puts a path in quotes when it has a control character, a quote or a backslash, and escapes it as C does */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, path.lastIndexOf('"'));
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i]));
    } else if (/[0-7]{3}/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(ESCAPES[body[i + 1]] ?? body[i + 1]));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `--- a/x` or `+++ b/x` line, or undefined for /dev/null. git adds a tab after a path with a space. */
function headerPath(line: string): string | undefined {
  const raw = unquote(line.slice(4).replace(/\t$/, ''));
  return raw === '/dev/null' ? undefined : raw.slice(2);
}

interface HunkState {
  files: Map<string, FileHunks>;
  oldPath?: string;
  current?: FileHunks;
  oldLine: number;
  newLine: number;
  /** Lines left in the hunk. Inside a hunk, a line such as "--- a/x" is a removed line, not a header. */
  oldLeft: number;
  newLeft: number;
}

/** A line inside a hunk. "\ No newline at end of file" is not an added or a removed line. */
function readHunkLine(state: HunkState, line: string) {
  if (line.startsWith('-') && state.oldLeft > 0) {
    state.current?.removed.push(state.oldLine++);
    state.oldLeft--;
  } else if (line.startsWith('+') && state.newLeft > 0) {
    state.current?.added.push(state.newLine++);
    state.newLeft--;
  }
}

function readHeaderLine(state: HunkState, line: string) {
  if (line.startsWith('diff --git ')) {
    state.current = undefined;
    state.oldPath = undefined;
  } else if (line.startsWith('--- ')) {
    state.oldPath = headerPath(line);
  } else if (line.startsWith('+++ ')) {
    const path = headerPath(line) ?? state.oldPath;
    if (path === undefined) return;
    state.current = { added: [], removed: [] };
    state.files.set(path, state.current);
  } else {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) return;
    state.oldLine = Number(hunk[1]);
    state.oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    state.newLine = Number(hunk[3]);
    state.newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
  }
}

/** The line numbers of each file in a `git diff --unified=0`, keyed by the path of parseNumstat */
export function parseHunks(diff: string): Map<string, FileHunks> {
  const state: HunkState = { files: new Map(), oldLine: 0, newLine: 0, oldLeft: 0, newLeft: 0 };
  for (const line of diff.split('\n')) {
    if (state.oldLeft > 0 || state.newLeft > 0) readHunkLine(state, line);
    else readHeaderLine(state, line);
  }
  return state.files;
}
