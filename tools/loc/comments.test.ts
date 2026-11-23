import { describe, expect, it } from 'vitest';
import { commentLines, languageOf } from './comments';

/** The comment-only lines of a file, as 1-based line numbers in order */
function comments(path: string, ...lines: string[]): number[] {
  return [...commentLines(lines.join('\n'), path)].sort((a, b) => a - b);
}

describe('languageOf', () => {
  it.each([
    ['apps/server/src/a.ts', 'script'],
    ['apps/web/src/A.tsx', 'script'],
    ['eslint.config.mjs', 'script'],
    ['docs/.vitepress/config.mts', 'script'],
    ['apps/web/public/theme-start.js', 'script'],
    ['tools/pi-image/build.sh', 'hash'],
    ['.github/workflows/ci.yml', 'hash'],
    ['docker-compose.yaml', 'hash'],
    ['Dockerfile', 'hash'],
    ['tools/pi-image/in-pi/chatter.service', 'hash'],
    ['tools/pi-image/in-pi/chatter-update.path', 'hash'],
    ['tools/pi-image/in-pi/chatter-facts.timer', 'hash'],
    ['.gitignore', 'hash'],
    ['.dockerignore', 'hash'],
    ['.gitattributes', 'hash'],
    ['apps/server/.env.example', 'hash'],
    ['apps/web/src/styles/app.css', 'css'],
    ['apps/web/index.html', 'html'],
    ['docs/.vitepress/theme/HeroLogo.vue', 'html'],
    ['package.json', 'none'],
    ['tools/pi-image/in-pi/update-keys/chatter-2026.pub', 'none'],
  ])('%s is %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe('commentLines in TypeScript', () => {
  it('counts a line with code and a trailing comment as code', () => {
    expect(comments('a.ts', 'const a = 1; // one', '// only a comment')).toEqual([2]);
  });

  it('counts each line of a block comment, also lines with no star', () => {
    expect(comments('a.ts', '/*', 'no star here', '   */', 'const a = 1;')).toEqual([1, 2, 3]);
  });

  it('counts each line of a JSDoc comment', () => {
    expect(
      comments('a.ts', '/**', ' * Says hello.', ' * @param name the name', ' */', 'export function hi(name: string) {}'),
    ).toEqual([1, 2, 3, 4]);
  });

  it('counts a JSDoc comment inside a class', () => {
    expect(comments('a.ts', 'class A {', '  /** The count */', '  #count = 0;', '  get() { return this.#count; }', '}')).toEqual([2]);
  });

  it('counts a comment at the end of the file', () => {
    expect(comments('a.ts', 'const a = 1;', '// the end')).toEqual([2]);
  });

  it('does not count a blank line as a comment', () => {
    expect(comments('a.ts', '// a', '', '   ', 'const b = 2;')).toEqual([1]);
  });

  it('does not see a comment in a string, a template or a regex', () => {
    expect(
      comments(
        'a.ts',
        "const a = '//';",
        'const b = `/*`;',
        'const c = `',
        '// in a template',
        '`;',
        'const d = /\\/\\*/;',
        "const e = 'x'; /* real, but on a code line */",
      ),
    ).toEqual([]);
  });

  it('counts #private fields as code', () => {
    expect(comments('a.ts', 'class A {', '  #x = 1;', '  y() {', '    return this.#x;', '  }', '}')).toEqual([]);
  });

  it('counts a JSX comment alone on its line as a comment, and inline as code', () => {
    expect(
      comments('a.tsx', 'const a = (', '  <div>', '    {/* a note */}', '    <b>x</b>{/* inline */}', '  </div>', ');'),
    ).toEqual([3]);
  });

  it('counts a JSX comment over more lines as comment lines', () => {
    expect(comments('a.tsx', 'const a = (', '  <div>', '    {/*', '      a note', '    */}', '  </div>', ');')).toEqual([3, 4, 5]);
  });

  it('does not see a comment in JSX text', () => {
    expect(
      comments('a.tsx', 'const a = (', '  <p>', "    don't stop", '    // not a comment', '    /* also not */', '  </p>', ');'),
    ).toEqual([]);
  });

  it('does not see a comment in JSX text that starts with //', () => {
    expect(comments('a.tsx', 'const a = (', '  <p>', '    // not a comment', '  </p>', ');')).toEqual([]);
    expect(comments('a.tsx', 'const a = (', '  <p>', '    {x}', '    // not a comment', '  </p>', ');')).toEqual([]);
  });

  it('counts the next lines of a block comment that starts after code as comment lines', () => {
    expect(comments('a.ts', 'const a = 1; /*', '  more', '*/', 'const b = 2;')).toEqual([2, 3]);
  });

  it('counts a shebang on line 1 as code', () => {
    expect(comments('a.ts', '#!/usr/bin/env node', '// c', 'const a = 1;')).toEqual([2]);
  });

  it('keeps going when the file has a syntax error', () => {
    expect(comments('a.ts', 'const = ;', '// still a comment', 'function (')).toEqual([2]);
  });

  it('reads files with Windows line ends', () => {
    expect(commentLines('// a\r\nconst b = 1;\r\n', 'a.ts')).toEqual(new Set([1]));
  });
});

describe('commentLines with # comments', () => {
  it('counts a line that starts with # as a comment, but not a shebang on line 1', () => {
    expect(comments('a.sh', '#!/usr/bin/env bash', '# say hello', '  # indented', 'echo hi # trailing', '')).toEqual([2, 3]);
  });

  it('does not see a comment in a YAML string', () => {
    expect(comments('a.yml', 'key: "a # b"', '# comment', 'other: 1')).toEqual([2]);
  });

  it('counts #! after line 1 as a comment', () => {
    expect(comments('Dockerfile', 'FROM node:22', '#! not a shebang here')).toEqual([2]);
  });
});

describe('commentLines in CSS and HTML', () => {
  it('finds CSS comments, and not /* in a string', () => {
    expect(
      comments(
        'a.css',
        '/* top */',
        'a::before { content: "/* no */"; }',
        "b { content: '\\'/*'; }",
        '/*',
        '  more',
        '*/',
        'c { color: red; } /* end */',
      ),
    ).toEqual([1, 4, 5, 6]);
  });

  it('does not start a comment at /* in a CSS string', () => {
    expect(comments('a.css', 'a { content: "/*"; }', 'b { color: red; }', 'c { color: blue; } /* x */')).toEqual([]);
    expect(comments('a.css', "a { content: '\\'/*'; }", 'b { color: red; }', '/* x */')).toEqual([3]);
  });

  it('finds HTML comments', () => {
    expect(comments('a.html', '<!-- top -->', "<p>don't</p>", '<!--', '  more', '-->', '<b>x</b> <!-- end -->')).toEqual([
      1, 3, 4, 5,
    ]);
  });
});

describe('commentLines of other files', () => {
  it('finds no comment in JSON or in a file with no comment rules', () => {
    expect(comments('package.json', '{', '  "//": "a"', '}')).toEqual([]);
    expect(comments('notes.txt', '# a', '// b')).toEqual([]);
  });
});
