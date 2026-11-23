import { describe, expect, it } from 'vitest';
import { anchorsOf, docsLinksIn, docsPageFile, headingLinksIn } from './docsLinks';

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

  it('skips a code block in a list item', () => {
    expect(anchorsOf('- x\n  ```\n  # fake\n  ```\n## Real')).toEqual(['real']);
  });
});

describe('headingLinksIn', () => {
  it('finds links to a heading of another page or of the same page', () => {
    const markdown = [
      'See [Back up](./update.md#back-up) and [the plan](#the-plan).',
      'Read [the security page](../security.md#keep-chatter-db-private) and [logs](logs.md#server-log).',
      'Also [the API](/api/history.md#alerts), [no .md](/guide/update#back-up) and [a page link](./update.md).',
    ].join('\n');

    expect(headingLinksIn(markdown, 'guide/logs.md')).toEqual([
      { file: 'guide/update.md', anchor: 'back-up' },
      { file: 'guide/logs.md', anchor: 'the-plan' },
      { file: 'security.md', anchor: 'keep-chatter-db-private' },
      { file: 'guide/logs.md', anchor: 'server-log' },
      { file: 'api/history.md', anchor: 'alerts' },
      { file: 'guide/update.md', anchor: 'back-up' },
    ]);
  });

  it('skips links to other sites, code blocks and inline code', () => {
    const markdown = [
      '[GitHub](https://github.com/toolpath/chatter#readme) and [mail](mailto:a@b.c#x)',
      '```md',
      '[in a block](./update.md#nothing)',
      '```',
      'Write `[a link](#not-a-link)` like this.',
    ].join('\n');

    expect(headingLinksIn(markdown, 'index.md')).toEqual([]);
  });

  it('decodes the anchor and reads a link with a title', () => {
    expect(headingLinksIn('[x](./update.md#caf%C3%A9 "Title")', 'guide/a.md')).toEqual([{ file: 'guide/update.md', anchor: 'café' }]);
  });

  it('reads a link in angle brackets', () => {
    expect(headingLinksIn('[a](<./x.md#angle>)', 'guide/a.md')).toEqual([{ file: 'guide/x.md', anchor: 'angle' }]);
  });

  it('skips a code block in a list item', () => {
    expect(headingLinksIn('- x\n  ```\n  [a](#code)\n  ```\n[b](#real)', 'a.md')).toEqual([{ file: 'a.md', anchor: 'real' }]);
  });
});
