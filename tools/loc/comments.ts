// Finds the lines of a source file that hold only a comment.
// A line is a comment line when each character on it that is not white space is inside a comment.
// A blank line is not a comment line. A line with code and a comment at its end is a code line.
import ts from 'typescript';

/** How a file writes its comments. "none": the file has no comments that we can find (JSON, keys, unknown files). */
export type Language = 'script' | 'hash' | 'css' | 'html' | 'none';

const HASH_NAMES = new Set(['Dockerfile', '.gitignore', '.dockerignore', '.gitattributes', '.env.example']);
const HASH_EXTENSIONS = new Set(['sh', 'bash', 'yml', 'yaml', 'service', 'path', 'timer']);
const SCRIPT_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

export function languageOf(path: string): Language {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (HASH_NAMES.has(name) || name.startsWith('Dockerfile.')) return 'hash';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
  if (HASH_EXTENSIONS.has(extension)) return 'hash';
  if (extension === 'css') return 'css';
  if (extension === 'html' || extension === 'vue') return 'html';
  return 'none';
}

/** The 1-based numbers of the lines that hold only a comment */
export function commentLines(text: string, path: string): Set<number> {
  switch (languageOf(path)) {
    case 'script':
      return linesInMask(text, scriptCommentMask(text, path));
    case 'hash':
      return hashCommentLines(text);
    case 'css':
      return linesInMask(text, cssCommentMask(text));
    case 'html':
      return linesInMask(text, htmlCommentMask(text));
    case 'none':
      return new Set();
  }
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.(tsx|jsx)$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * Marks each character that is inside a comment. The parser finds the comments, so `//` in a string,
 * a template, a regex or JSX text is not a comment. `{` and `}` around a JSX comment count as the comment.
 */
function scriptCommentMask(text: string, path: string): Uint8Array {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const mask = new Uint8Array(text.length);
  const ranges = new Map<number, number>();
  const jsxTexts: [number, number][] = [];

  const visit = (node: ts.Node) => {
    // A JSDoc node is a comment. The comment ranges of the node after it hold it.
    if (isJsDoc(node)) return;
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTexts.push([node.pos, node.end]);
      return;
    }
    if (ts.isJsxExpression(node) && !node.expression) mask.fill(1, node.getStart(source), node.end);
    for (const child of node.getChildren(source)) {
      const found = [...(ts.getLeadingCommentRanges(text, child.pos) ?? []), ...(ts.getTrailingCommentRanges(text, child.pos) ?? [])];
      for (const range of found) ranges.set(range.pos, range.end);
      visit(child);
    }
  };
  visit(source);

  for (const [pos, end] of ranges) {
    // The comment scan also reads JSX text as if it were code. Text in JSX is never a comment.
    if (jsxTexts.some(([start, stop]) => pos >= start && pos < stop)) continue;
    mask.fill(1, pos, end);
  }
  return mask;
}

/** A small state machine for CSS: `/* ... *\/`, but not inside a quoted string */
function cssCommentMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      mask.fill(1, i, end);
      i = end - 1;
    }
  }
  return mask;
}

/** `<!-- ... -->`. HTML text can hold an apostrophe, so quotes do not start a string here. */
function htmlCommentMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let start = text.indexOf('<!--');
  while (start >= 0) {
    const close = text.indexOf('-->', start + 4);
    const end = close < 0 ? text.length : close + 3;
    mask.fill(1, start, end);
    start = text.indexOf('<!--', end);
  }
  return mask;
}

/** Lines that start with `#`. A `#!` on line 1 is code (it tells which program runs the file). */
function hashCommentLines(text: string): Set<number> {
  const lines = new Set<number>();
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) return;
    if (index === 0 && line.startsWith('#!')) return;
    lines.add(index + 1);
  });
  return lines;
}

function linesInMask(text: string, mask: Uint8Array): Set<number> {
  const lines = new Set<number>();
  let line = 1;
  let hasComment = false;
  let hasCode = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (char === '\n' || i === text.length) {
      if (hasComment && !hasCode) lines.add(line);
      line++;
      hasComment = false;
      hasCode = false;
    } else if (!/\s/.test(char)) {
      if (mask[i]) hasComment = true;
      else hasCode = true;
    }
  }
  return lines;
}
