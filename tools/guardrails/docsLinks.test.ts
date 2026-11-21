import { describe, expect, it } from 'vitest';
import { anchorsOf, docsLinksIn, docsPageFile } from './docsLinks';

describe('docsLinksIn', () => {
  it('finds full links, DocsLink pages and docsUrl calls', () => {
    const text = [
      'See https://toolpath.github.io/chatter/guide/logs, or [the API](https://toolpath.github.io/chatter/api/).',
      '<DocsLink page="guide/update#back-up">Back up</DocsLink>',
      "const url = docsUrl('guide/alerts');",
    ].join('\n');

    expect(docsLinksIn(text)).toEqual(['guide/logs', 'api/', 'guide/update#back-up', 'guide/alerts']);
  });
});

describe('docsPageFile', () => {
  it('gives the Markdown file of a page', () => {
    expect(docsPageFile('guide/logs')).toBe('guide/logs.md');
    expect(docsPageFile('guide/logs.html')).toBe('guide/logs.md');
    expect(docsPageFile('api/')).toBe('api/index.md');
    expect(docsPageFile('')).toBe('index.md');
  });
});

describe('anchorsOf', () => {
  it('reads custom anchors and makes anchors from headings as VitePress does', () => {
    const markdown = [
      '# Update Chatter',
      '## Back up and restore {#back-up}',
      '### If an update goes wrong',
      '## Memory on a Pi (512 MB)',
      '```bash',
      '# not a heading',
      '```',
    ].join('\n');

    expect(anchorsOf(markdown)).toEqual(['update-chatter', 'back-up', 'if-an-update-goes-wrong', 'memory-on-a-pi-512-mb']);
  });

  it('makes the same anchors as VitePress from dots, digits, links and code', () => {
    const markdown = [
      '## Keep `chatter.db` private',
      '## 1. Create the Admin login',
      '## Read [the logs](./logs.md) first',
      '## Café: settings_and more',
    ].join('\n');

    expect(anchorsOf(markdown)).toEqual([
      'keep-chatter-db-private',
      '_1-create-the-admin-login',
      'read-the-logs-first',
      'cafe-settings-and-more',
    ]);
  });

  it('adds a number to a heading that is already on the page', () => {
    expect(anchorsOf('## Steps\n## Steps\n## Steps')).toEqual(['steps', 'steps-1', 'steps-2']);
  });

  it('skips code blocks with tildes', () => {
    expect(anchorsOf('~~~bash\n# not a heading\n~~~\n## Real')).toEqual(['real']);
  });
});
