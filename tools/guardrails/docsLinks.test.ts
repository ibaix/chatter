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
});
