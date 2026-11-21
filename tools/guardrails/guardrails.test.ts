// Tests for the guardrails in AGENTS.md. Each test names the rule that it keeps.
// These rules protect users in the field, so a failure here blocks a change.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { anchorsOf, docsLinksIn, docsPageFile } from './docsLinks';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

interface ComposeService {
  ports?: (string | { published?: string | number; host_ip?: string })[];
  volumes?: string[];
}
interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}
const compose = (path: string) => parse(read(path)) as ComposeFile;

describe('FANUC files', () => {
  it('are not in git, because the FOCAS2 library belongs to FANUC', () => {
    const fanucFiles = trackedFiles().filter(file => /(^|\/)(fwlib[^/]*|libfwlib32[^/]*)$/i.test(file));
    expect(fanucFiles).toEqual([]);
  });

  it('stay out of git through .gitignore', () => {
    expect(read('.gitignore')).toContain('apps/server/native/focas/**');
  });
});

describe('user data', () => {
  // Docker Compose puts the project name before each volume name: chatter_chatterbox-data.
  // A different project name or volume name makes an update lose the user's data.
  const main = compose('docker-compose.yml');

  it('keeps the volume names in docker-compose.yml', () => {
    expect(Object.keys(main.volumes ?? {})).toEqual(expect.arrayContaining(['chatterbox-data', 'victoriametrics-data']));
    expect(main.services.chatterbox.volumes).toContain('chatterbox-data:/app/data');
    expect(main.services.victoriametrics.volumes).toContain('victoriametrics-data:/storage');
  });

  it('lets the folder name set the project name in docker-compose.yml', () => {
    expect(main.name).toBeUndefined();
  });

  it('keeps the folder name "chatter" in the Docker package', () => {
    const script = read('tools/release/make-docker-package.sh');
    expect(script).toContain('package_dir="$work_dir/chatter"');
    expect(script).toMatch(/zip [^\n]* chatter\)/);
  });

  it('keeps the folder /opt/chatter on the Pi card', () => {
    expect(read('tools/pi-image/in-pi/chatter.service')).toContain('WorkingDirectory=/opt/chatter');
  });
});

describe('closed ports', () => {
  // VictoriaMetrics (8428), vmalert (8880) and the alert port (3002) have no login.
  const noLoginPorts = ['8428', '8880', '3002'];
  const composeFiles = trackedFiles().filter(file => /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file));

  it('finds the compose files', () => {
    expect(composeFiles).toContain('docker-compose.yml');
  });

  it('publishes no port of VictoriaMetrics or vmalert in docker-compose.yml', () => {
    const { services } = compose('docker-compose.yml');
    expect(services.victoriametrics.ports).toBeUndefined();
    expect(services.vmalert.ports).toBeUndefined();
  });

  it.each(composeFiles)('publishes a port with no login in %s only to this computer', file => {
    const opened = Object.entries(compose(file).services ?? {}).flatMap(([service, { ports = [] }]) =>
      ports
        .map(port => (typeof port === 'string' ? port : `${port.host_ip ?? ''}:${port.published ?? ''}`))
        .filter(port => noLoginPorts.some(noLogin => port.split(':').includes(noLogin)))
        .filter(port => !port.startsWith('127.0.0.1:'))
        .map(port => `${service}: ${port}`),
    );
    expect(opened).toEqual([]);
  });
});

describe('docs links', () => {
  // Released apps link to these pages. Users with an old version still click them.
  const releasedLinks = ['guide/update#back-up', 'guide/manage'];

  function sourceFiles(dir: string): string[] {
    return readdirSync(join(ROOT, dir)).flatMap(name => {
      const path = `${dir}/${name}`;
      if (name === 'node_modules' || name === 'dist') return [];
      if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path);
      return /\.(tsx?|md)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  const linksInApp = [...new Set(['apps', 'plugins', 'README.md'].flatMap(path =>
    (path.endsWith('.md') ? [path] : sourceFiles(path)).flatMap(file => docsLinksIn(read(file))),
  ))];

  it('finds the links in the app', () => {
    expect(linksInApp).toContain('guide/update#back-up');
  });

  it.each([...new Set([...releasedLinks, ...linksInApp])])('%s goes to a page and a heading that exist', link => {
    const [page, anchor] = link.split('#');
    const file = docsPageFile(page);
    expect(existsSync(join(ROOT, 'docs', file)), `docs/${file}`).toBe(true);
    if (anchor) expect(anchorsOf(read(join('docs', file)))).toContain(anchor);
  });
});
