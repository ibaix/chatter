// Checks the built web app (apps/web/dist) against the Content-Security-Policy of the server
// (apps/server/src/securityHeaders.ts). The policy blocks scripts in the page, eval and files from other sites.
// A build that breaks a rule shows a blank or broken page, so the CI stops it here.
// Run: npm run check:web-dist (after npm run build)

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';

/** The parts of a parse5 node that the check reads */
interface HtmlNode {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

function* allNodes(node: HtmlNode): Generator<HtmlNode> {
  yield node;
  for (const child of node.childNodes ?? []) yield* allNodes(child);
  if (node.content) yield* allNodes(node.content);
}

/** The problems in the page: a script with no file, script text in the page, or an event attribute (such as onload) */
export function problemsInHtml(html: string): string[] {
  const problems: string[] = [];
  for (const node of allNodes(parse(html) as unknown as HtmlNode)) {
    const attrs = node.attrs ?? [];
    if (node.nodeName === 'script') {
      if (!attrs.some(attr => attr.name === 'src' && attr.value.trim() !== '')) problems.push('a <script> has no src');
      const text = (node.childNodes ?? []).map(child => child.value ?? '').join('').trim();
      if (text !== '') problems.push(`a <script> has text in the page: ${text.slice(0, 60)}`);
    }
    for (const attr of attrs) {
      if (attr.name.toLowerCase().startsWith('on')) problems.push(`<${node.nodeName}> has the event attribute ${attr.name}`);
    }
  }
  return problems;
}

/** Text around a match, because a built file is often one long line */
function around(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 40).replace(/\s+/g, ' ');
}

function problemsOf(file: string, text: string, patterns: [RegExp, string][]): string[] {
  return patterns.flatMap(([pattern, what]) =>
    [...text.matchAll(pattern)].map(match => `${file}: ${what}: ...${around(text, match.index)}...`));
}

/** The problems in a script: eval and new Function, which the policy blocks ('unsafe-eval' is not in it) */
export function problemsInJs(file: string, text: string): string[] {
  return problemsOf(file, text, [
    [/(?<![\w$])eval\s*\(/g, 'eval('],
    [/(?<![\w$])new\s+Function\s*\(/g, 'new Function('],
  ]);
}

/** The problems in a style sheet: @import, or a url() to another site. A data: address and a path on this server are good. */
export function problemsInCss(file: string, text: string): string[] {
  return problemsOf(file, text, [
    [/@import\b/gi, '@import'],
    [/url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:(?<!data:)|\/\/)/gi, 'url() to another site'],
  ]);
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));
}

/** All the problems in a built web app folder */
export function problemsInBuiltWebApp(distDir: string): string[] {
  const files = filesIn(distDir);
  const read = (file: string) => readFileSync(file, 'utf8');
  const name = (file: string) => relative(distDir, file);
  const indexHtml = join(distDir, 'index.html');
  if (!files.includes(indexHtml)) return [`${distDir} has no index.html. Run npm run build first.`];
  return [
    ...problemsInHtml(read(indexHtml)).map(problem => `index.html: ${problem}`),
    ...files.filter(file => file.endsWith('.js')).flatMap(file => problemsInJs(name(file), read(file))),
    ...files.filter(file => file.endsWith('.css')).flatMap(file => problemsInCss(name(file), read(file))),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distDir = process.argv[2] ?? 'apps/web/dist';
  const problems = problemsInBuiltWebApp(distDir);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`${problems.length} problems in ${distDir}. The Content-Security-Policy of the server blocks these.`);
    process.exit(1);
  }
  console.log(`${distDir} has no script in the page, no eval and no style from another site.`);
}
