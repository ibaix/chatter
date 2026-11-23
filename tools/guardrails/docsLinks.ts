// Finds links from the app to the docs site, and the pages and headings that they go to.
import { posix } from 'node:path';

const DOCS_SITE = 'https://toolpath.github.io/chatter/';

/** The page part of each docs link in a file, for example "guide/update#back-up". */
export function docsLinksIn(text: string): string[] {
  const patterns = [
    new RegExp(`${DOCS_SITE.replace(/[./]/g, '\\$&')}([A-Za-z0-9/#._-]*[A-Za-z0-9/_-])`, 'g'),
    /<DocsLink[^>]*\spage="([^"]+)"/g,
    /docsUrl\('([^']+)'\)/g,
  ];
  const found: { at: number; link: string }[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, link: match[1] });
  }
  return found.sort((a, b) => a.at - b.at).map(({ link }) => link);
}

/** The Markdown file in docs/ of a page, for example "guide/logs.md" or "api/index.md". */
export function docsPageFile(page: string): string {
  const path = page.replace(/\.html$/, '');
  return path === '' || path.endsWith('/') ? `${path}index.md` : `${path}.md`;
}

/** The heading anchors of a Markdown page: a {#custom} anchor, or the heading text as VitePress makes it. */
export function anchorsOf(markdown: string): string[] {
  const anchors: string[] = [];
  for (const line of linesOutsideCodeBlocks(markdown)) {
    const heading = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const custom = /\{#([^}]+)\}\s*$/.exec(heading[1]);
    if (custom) {
      // VitePress stops the build when a custom anchor is already on the page
      anchors.push(custom[1]);
      continue;
    }
    // As markdown-it-anchor in VitePress does: when the anchor is already on the page (from a heading or
    // a {#id}), try -1, -2, ... until one is free
    const base = slug(textOf(heading[1]));
    let anchor = base;
    for (let i = 1; anchors.includes(anchor); i++) anchor = `${base}-${i}`;
    anchors.push(anchor);
  }
  return anchors;
}

/**
 * The lines of a Markdown page that are not in a code block (``` or ~~~). As in CommonMark, a code block ends at
 * a fence of the same character that is at least as long as the opening fence and has no text after it.
 */
function linesOutsideCodeBlocks(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of withoutFrontmatter(markdown).split('\n')) {
    const mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === undefined && mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
      fence = mark[1];
      continue;
    }
    if (fence !== undefined && mark?.[1][0] === fence[0] && mark[1].length >= fence.length && mark[2].trim() === '') {
      fence = undefined;
      continue;
    }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

/** The page without the YAML frontmatter (the lines from a first line "---" to the next "---"), which VitePress does not show */
function withoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---[ \t]*\r?\n(?:.*\r?\n)*?---[ \t]*(?:\r?\n|$)/, '');
}

export interface HeadingLink {
  /** The Markdown file of the page that the link goes to, from docs/, for example "guide/update.md" */
  file: string;
  /** The heading anchor, for example "back-up" */
  anchor: string;
  /** The target as written, when the anchor has a bad %-code. The link goes to no heading. */
  invalid?: string;
}

/**
 * The links of a docs page (file, from docs/) to a heading of a docs page, for example "./update.md#back-up"
 * or "#back-up". Links to other sites, and links in code, are not included.
 */
export function headingLinksIn(markdown: string, file: string): HeadingLink[] {
  const links: HeadingLink[] = [];
  for (const line of linesOutsideCodeBlocks(markdown)) {
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const target of linkTargetsIn(withoutCode)) {
      const hash = target.indexOf('#');
      if (hash < 0 || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const page = target.slice(0, hash).replace(/\?.*$/, '');
      const linked = page === '' ? file : linkedPageFile(page, file);
      const raw = target.slice(hash + 1);
      try {
        links.push({ file: linked, anchor: decodeURIComponent(raw) });
      } catch {
        links.push({ file: linked, anchor: raw, invalid: target });
      }
    }
  }
  return links;
}

// An inline link [text](target "title"), with the title in "", '' or (), and the target maybe in <>
const INLINE_LINK = /\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
// A reference definition [label]: target "title"
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;

/** The targets of the inline links and of the reference definition in a line of Markdown */
function linkTargetsIn(line: string): string[] {
  const targets = [...line.matchAll(INLINE_LINK)].map(match => match[1]);
  const reference = REFERENCE_DEFINITION.exec(line)?.[1];
  return reference === undefined ? targets : [...targets, reference];
}

/** The Markdown file (from docs/) of a link to a page (with no #anchor), from the page in file */
function linkedPageFile(page: string, file: string): string {
  const joined = page.startsWith('/') ? page.slice(1) : posix.join(posix.dirname(file), page);
  // A link to a folder ("/", "../", "./sub/") goes to the index page of the folder
  const path = posix.normalize(joined).replace(/^\.(\/|$)/, '');
  return docsPageFile(path.replace(/\.md$/, ''));
}

/** The text of a heading as the page shows it: a link gives its text only. */
function textOf(heading: string): string {
  return heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

// A copy of slugify in @mdit-vue/shared, which VitePress uses to make heading anchors
// eslint-disable-next-line no-control-regex -- the same control characters that VitePress removes
const CONTROL = /[\u0000-\u001f]/g;
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g;
const COMBINING = /[\u0300-\u036F]/g;

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING, '')
    .replace(CONTROL, '')
    .replace(SPECIAL, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}
