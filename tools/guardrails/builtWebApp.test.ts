import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { problemsInBuiltWebApp, problemsInCss, problemsInHtml, problemsInJs } from './builtWebApp';

const GOOD_PAGE = `<!DOCTYPE html><html><head>
  <script src="/theme-start.js"></script>
  <script type="module" crossorigin src="/assets/index-abc.js"></script>
  <link rel="stylesheet" href="/assets/index-abc.css">
</head><body><div id="root"></div></body></html>`;

describe('problemsInHtml', () => {
  it('accepts a page that loads each script from a file', () => {
    expect(problemsInHtml(GOOD_PAGE)).toEqual([]);
  });

  it.each([
    ['a plain script', '<script>alert(1)</script>'],
    ['a script with a type', '<script type="text/javascript">alert(1)</script>'],
    ['a module script', '<script type="module">import "/x.js"</script>'],
    ['a script with a src and text', '<script src="/a.js">alert(1)</script>'],
  ])('finds %s in the page', (_, script) => {
    expect(problemsInHtml(GOOD_PAGE.replace('</body>', `${script}</body>`))).not.toEqual([]);
  });

  it('finds an empty script with no src', () => {
    expect(problemsInHtml('<html><head><script></script></head></html>')).toEqual(['a <script> has no src']);
  });

  it.each(['<body onload="x()">', '<body ONLOAD="x()">', '<body><img src="a.png" onerror="x()">'])('finds the event attribute in %s', tag => {
    const problems = problemsInHtml(GOOD_PAGE.replace('<body>', tag));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/event attribute on(load|error)/);
  });

  it('finds a script in a <template>', () => {
    expect(problemsInHtml('<html><body><template><script>alert(1)</script></template></body></html>')).not.toEqual([]);
  });
});

describe('problemsInJs', () => {
  it.each(['eval("1+1")', 'window.eval (code)', 'x=new Function("return 1")', 'x=new  Function ("a", "b")'])('finds %s', code => {
    expect(problemsInJs('assets/index.js', code)).toHaveLength(1);
  });

  it('tells the file and the text around the match', () => {
    expect(problemsInJs('assets/index.js', 'let a=1;eval(b)')[0]).toBe('assets/index.js: eval(: ...let a=1;eval(b)...');
  });

  it.each(['retrieval(x)', 'myEval(x)', '$eval(x)', 'newFunction(x)', 'isFunction(x)', 'const evaluate = 1'])('accepts %s', code => {
    expect(problemsInJs('assets/index.js', code)).toEqual([]);
  });
});

describe('problemsInCss', () => {
  it.each([
    '@import "https://fonts.example.com/a.css";',
    '@IMPORT url(/a.css);',
    'a{background:url(https://example.com/a.png)}',
    'a{background:url("http://example.com/a.png")}',
    "@font-face{src:url( '//example.com/a.woff2')}",
  ])('finds %s', css => {
    expect(problemsInCss('assets/index.css', css)).toHaveLength(1);
  });

  it.each([
    '@font-face{src:url(/assets/nunito-latin-700-normal.woff2) format("woff2")}',
    'a{background:url("data:image/svg+xml,%3csvg%3e")}',
    "a{background:url('DATA:image/png;base64,AAAA')}",
    'a{background:url(./a.png)}',
    'a{background:url(a.png)}',
  ])('accepts %s', css => {
    expect(problemsInCss('assets/index.css', css)).toEqual([]);
  });
});

describe('problemsInBuiltWebApp', () => {
  let dist: string;

  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  function buildFolder(files: Record<string, string>): string {
    dist = mkdtempSync(join(tmpdir(), 'chatter-dist-'));
    mkdirSync(join(dist, 'assets'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dist, name), text);
    return dist;
  }

  it('accepts a good build', () => {
    expect(problemsInBuiltWebApp(buildFolder({
      'index.html': GOOD_PAGE,
      'theme-start.js': 'document.documentElement.dataset.theme = "light";',
      'assets/index-abc.js': 'console.log(1)',
      'assets/index-abc.css': 'a{background:url(/assets/a.png)}',
    }))).toEqual([]);
  });

  it('finds the problems in the page, the scripts and the style sheets', () => {
    const problems = problemsInBuiltWebApp(buildFolder({
      'index.html': GOOD_PAGE.replace('<body>', '<body onload="x()">'),
      'assets/index-abc.js': 'eval(x)',
      'assets/index-abc.css': '@import url(https://example.com/a.css);',
    }));
    expect(problems).toHaveLength(4);
    expect(problems[0]).toBe('index.html: <body> has the event attribute onload');
    expect(problems[1]).toMatch(/^assets[/\\]index-abc\.js: eval\(/);
    expect(problems.slice(2).every(problem => /^assets[/\\]index-abc\.css: /.test(problem))).toBe(true);
  });

  it('tells to build first when the folder has no index.html', () => {
    expect(problemsInBuiltWebApp(buildFolder({}))).toEqual([expect.stringContaining('Run npm run build first')]);
  });
});
