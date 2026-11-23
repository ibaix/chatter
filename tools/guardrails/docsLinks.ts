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
  const seen = new Map<string, number>();
  for (const line of linesOutsideCodeBlocks(markdown)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const custom = /\{#([^}]+)\}\s*$/.exec(heading[1]);
    if (custom) {
      anchors.push(custom[1]);
      continue;
    }
    // VitePress adds -1, -2, ... to a heading anchor that is already on the page
    const base = slug(textOf(heading[1]));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.push(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** The lines of a Markdown page that are not in a code block (``` or ~~~). */
function linesOutsideCodeBlocks(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const fenceMark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fenceMark && (fence === undefined || fence === fenceMark)) {
      fence = fence === undefined ? fenceMark : undefined;
      continue;
    }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

export interface HeadingLink {
  /** The Markdown file of the page that the link goes to, from docs/, for example "guide/update.md" */
  file: string;
  /** The heading anchor, for example "back-up" */
  anchor: string;
}

/**
 * The links of a docs page (file, from docs/) to a heading of a docs page, for example "./update.md#back-up"
 * or "#back-up". Links to other sites, and links in code, are not included.
 */
export function headingLinksIn(markdown: string, file: string): HeadingLink[] {
  const links: HeadingLink[] = [];
  for (const line of linesOutsideCodeBlocks(markdown)) {
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const [, target] of withoutCode.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const hash = target.indexOf('#');
      if (hash < 0 || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const page = target.slice(0, hash);
      const anchor = decodeURIComponent(target.slice(hash + 1));
      if (page === '') {
        links.push({ file, anchor });
        continue;
      }
      const path = page.startsWith('/') ? page.slice(1) : posix.join(posix.dirname(file), page);
      links.push({ file: docsPageFile(posix.normalize(path).replace(/\.md$/, '')), anchor });
    }
  }
  return links;
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
