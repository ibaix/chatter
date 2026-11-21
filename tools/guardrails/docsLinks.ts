// Finds links from the app to the docs site, and the pages and headings that they go to.

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
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const fenceMark = /^(```|~~~)/.exec(line)?.[1];
    if (fenceMark && (fence === undefined || fence === fenceMark)) {
      fence = fence === undefined ? fenceMark : undefined;
      continue;
    }
    const heading = fence === undefined && /^#{1,6}\s+(.*)$/.exec(line);
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
