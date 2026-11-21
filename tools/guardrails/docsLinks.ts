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
  let inCode = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    const heading = !inCode && /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const custom = /\{#([^}]+)\}\s*$/.exec(heading[1]);
    anchors.push(custom ? custom[1] : slug(heading[1]));
  }
  return anchors;
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}
