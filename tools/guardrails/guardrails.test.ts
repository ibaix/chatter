// Tests for the guardrails in AGENTS.md. Each test names the rule that it keeps.
// These rules protect users in the field, so a failure here blocks a change.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { portsOpened, type ComposePort } from './composePorts';
import { anchorsOf, docsLinksIn, docsPageFile } from './docsLinks';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

interface ComposeService {
  command?: string[];
  ports?: ComposePort[];
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

  it('keeps one folder, "chatter", in the zip of the Docker package', () => {
    // The last word of the zip command is the folder that goes into the zip
    const zipCommands = [...read('tools/release/make-docker-package.sh').matchAll(/\bzip\s+-[^\n]*/g)].map(([line]) => line);
    expect(zipCommands).toHaveLength(1);
    expect(zipCommands[0].replace(/[)\s]+$/, '').split(/\s+/).at(-1)).toBe('chatter');
  });

  it('keeps the folder /opt/chatter on the Pi card', () => {
    expect(read('tools/pi-image/in-pi/chatter.service')).toContain('WorkingDirectory=/opt/chatter');
  });
});

describe('closed ports', () => {
  // VictoriaMetrics (8428), vmalert (8880) and the alert port (3002) have no login.
  const noLoginPorts = [8428, 8880, 3002];
  const thisComputerOnly = ['127.0.0.1', 'localhost', '::1'];
  const composeFiles = trackedFiles().filter(file => /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file));

  it('finds the compose files', () => {
    expect(composeFiles).toContain('docker-compose.yml');
  });

  it.each(composeFiles)('uses no variable in a port of %s, so that this test can read each port', file => {
    const withVariable = Object.values(compose(file).services ?? {})
      .flatMap(({ ports = [] }) => ports)
      .filter(port => JSON.stringify(port).includes('$'));
    expect(withVariable).toEqual([]);
  });

  it('publishes no port of VictoriaMetrics or vmalert in docker-compose.yml', () => {
    const { services } = compose('docker-compose.yml');
    expect(services.victoriametrics.ports).toBeUndefined();
    expect(services.vmalert.ports).toBeUndefined();
  });

  it.each(composeFiles)('publishes a port with no login in %s only to this computer', file => {
    const opened = Object.entries(compose(file).services ?? {}).flatMap(([service, { ports = [] }]) =>
      ports
        .filter(port => {
          const { hostIp, containerPorts } = portsOpened(port);
          return !thisComputerOnly.includes(hostIp) && containerPorts.some(p => noLoginPorts.includes(p));
        })
        .map(port => `${service}: ${JSON.stringify(port)}`),
    );
    expect(opened).toEqual([]);
  });
});

describe('history restore', () => {
  // A history restore writes the samples of a backup file into VictoriaMetrics. When it runs two times, the
  // deduplication keeps one sample for each time, so the charts and the reports do not count a sample two times.
  it.each(['docker-compose.yml', 'docker-compose.dev.yml'])('keeps the deduplication of VictoriaMetrics in %s', file => {
    expect(compose(file).services.victoriametrics.command).toContain('-dedup.minScrapeInterval=1ms');
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

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: unknown;
  secrets?: unknown;
  steps?: WorkflowStep[];
}
interface Workflow {
  permissions?: unknown;
  jobs: Record<string, WorkflowJob>;
}
const workflowFiles = readdirSync(join(ROOT, '.github/workflows')).filter(file => /\.ya?ml$/.test(file));
const workflowText = (file: string) => read(join('.github/workflows', file));
const workflow = (file: string) => parse(workflowText(file)) as Workflow;
const allJobs = () =>
  workflowFiles.flatMap(file => Object.entries(workflow(file).jobs).map(([name, job]) => ({ id: `${file}: ${name}`, job })));

describe('workflow permissions', () => {
  // The token of a workflow can change the repo, the releases and the images on ghcr.io.
  // Each workflow reads only by default. A job that must write gets the permission in its own block.
  // The scopes that a permissions block can write: "write-all" or each scope with a level other than read or none
  function writeScopes(permissions: unknown): string[] {
    if (permissions === undefined || permissions === 'read-all') return [];
    if (typeof permissions === 'string') return [permissions];
    if (permissions === null || typeof permissions !== 'object') return [String(permissions)];
    return Object.entries(permissions as Record<string, string>)
      .filter(([, level]) => level !== 'read' && level !== 'none')
      .map(([scope]) => scope)
      .sort();
  }

  it('finds the workflows', () => {
    expect(workflowFiles).toContain('ci.yml');
  });

  // A top level with no permissions block gives the default token, which can write. So the block must be there.
  // "read-all", {} and the levels read and none are read only.
  function isReadOnlyTop(permissions: unknown) {
    if (permissions === undefined || permissions === null) return false;
    return writeScopes(permissions).length === 0;
  }

  it.each(workflowFiles)('gives only read permissions at the top of %s', file => {
    expect(isReadOnlyTop(workflow(file).permissions), JSON.stringify(workflow(file).permissions)).toBe(true);
  });

  it.each([
    [{ contents: 'read' }, true],
    [{}, true],
    ['read-all', true],
    [undefined, false],
    [null, false],
    ['write-all', false],
    [{ contents: 'write' }, false],
  ])('reads a top level of %j as read only: %s', (permissions, expected) => {
    expect(isReadOnlyTop(permissions)).toBe(expected);
  });

  // Only these jobs can write, each with exactly these scopes. A new job that writes must be added here in review.
  const writers: Record<string, Record<string, string[]>> = {
    'card.yml': { card: ['contents'] },
    'docker.yml': { publish: ['packages'], sign: ['contents'], release: ['contents'], card: ['contents'] },
    'docs.yml': { deploy: ['id-token', 'pages'] },
    'ghcr-cleanup.yml': { cleanup: ['packages'] },
    'release-tags.yml': { tags: ['packages'] },
  };
  const jobIds = workflowFiles.flatMap(file => Object.keys(workflow(file).jobs).map(job => [file, job] as const));

  it('finds each allow-listed job in the workflows', () => {
    const missing = Object.entries(writers).flatMap(([file, jobs]) =>
      Object.keys(jobs).filter(job => !existsSync(join(ROOT, '.github/workflows', file)) || !workflow(file).jobs[job]).map(job => `${file}/${job}`),
    );
    expect(missing).toEqual([]);
  });

  it.each(jobIds)('gives %s (job %s) only the write permissions of the allow-list', (file, job) => {
    expect(writeScopes(workflow(file).jobs[job].permissions)).toEqual(writers[file]?.[job] ?? []);
  });

  it.each([
    [undefined, []],
    [{}, []],
    ['read-all', []],
    [{ contents: 'read', packages: 'none' }, []],
    ['write-all', ['write-all']],
    [{ pages: 'write', 'id-token': 'write', contents: 'read' }, ['id-token', 'pages']],
  ])('reads the write scopes of %j as %j', (permissions, expected) => {
    expect(writeScopes(permissions)).toEqual(expected);
  });

  // A run by hand from a branch would use the workflow file of that branch, with a token that can change a release
  // or the images. A job with more conditions has the gate first, as "(gate) && (other conditions)".
  // These workflows can start by hand (workflow_dispatch), so each job of them that writes has the gate.
  const mainOrTag = "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')";
  const gatedFiles = ['card.yml', 'ghcr-cleanup.yml', 'release-tags.yml'];
  const gatedJobs = gatedFiles.flatMap(file => Object.keys(writers[file] ?? {}).map(job => [file, job] as const));

  it('finds the writing jobs that need the gate', () => {
    expect(gatedJobs.map(([file]) => file)).toEqual(gatedFiles);
  });

  it.each(gatedJobs)('runs %s (job %s) only from main or a release tag', (file, job) => {
    const condition = workflow(file).jobs[job]?.if?.replace(/\s+/g, ' ') ?? '';
    const rest = condition.startsWith(`(${mainOrTag}) && `) ? condition.slice(mainOrTag.length + 6) : '';
    expect(condition === mainOrTag || isOneGroup(rest), condition).toBe(true);
  });

  // True for "(a || b)", false for "(a) || (b)": an || after the group would skip the gate.
  function isOneGroup(text: string) {
    let depth = 0;
    for (const [index, char] of [...text].entries()) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      if (depth === 0) return index === text.length - 1 && char === ')';
    }
    return false;
  }

  it.each([
    ['(a || b)', true],
    ['(a) || (b)', false],
    ['a', false],
    ['', false],
  ])('reads %j as one group: %s', (text, expected) => {
    expect(isOneGroup(text)).toBe(expected);
  });
});

describe('pinned actions', () => {
  // A tag such as v4 can move to other code. A full commit cannot. A changed action could change the files that
  // the release signs. The comment gives the version, so Dependabot can update the commit and the comment.
  // A local action or workflow (./) is in this repo, so it needs no commit.
  const usesLine = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
  const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
  const versionComment = /^\s+# v\d+(\.\d+)*$/;

  it.each(workflowFiles)('pins each action in %s by a full commit, with the version in a comment', file => {
    const notPinned = workflowText(file)
      .split('\n')
      .map(line => usesLine.exec(line))
      .filter(match => match !== null)
      .filter(([, action, rest]) => !action.startsWith('./') && !(pinned.test(action) && versionComment.test(rest)))
      .map(([line]) => line.trim());
    expect(notPinned).toEqual([]);
  });
});

describe('release signing', () => {
  // The update signing key signs each update file. Each Pi card installs a signed update as root.
  // Only the sign job in docker.yml gets the key. It runs no action except the checkout, and it signs only a tag
  // on main, after the publish job.
  const SIGN_JOB = 'docker.yml: sign';
  const { publish, sign, release } = workflow('docker.yml').jobs;
  const environmentOf = (job: WorkflowJob) => (typeof job.environment === 'object' ? job.environment.name : job.environment);
  const needsOf = (job: WorkflowJob) => [job.needs ?? []].flat();
  const stepIndex = (job: WorkflowJob, test: (step: WorkflowStep) => boolean) => (job.steps ?? []).findIndex(test);
  const onMainCheck = (step: WorkflowStep) => step.run?.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main') ?? false;

  it('gives the signing key only to the sign job', () => {
    expect(allJobs().filter(({ job }) => JSON.stringify(job).includes('UPDATE_SIGNING_KEY')).map(({ id }) => id)).toEqual([SIGN_JOB]);
    const mentions = workflowFiles.flatMap(file => workflowText(file).match(/secrets\.UPDATE_SIGNING_KEY/g) ?? []);
    expect(mentions).toHaveLength(1);
  });

  it('gives the release environment, which holds the key, only to the sign job', () => {
    expect(allJobs().filter(({ job }) => environmentOf(job) === 'release').map(({ id }) => id)).toEqual([SIGN_JOB]);
  });

  it('gives no job all the secrets', () => {
    expect(allJobs().filter(({ job }) => job.secrets === 'inherit').map(({ id }) => id)).toEqual([]);
  });

  it('runs no action in the sign job except the checkout, as the first step', () => {
    const actions = (sign.steps ?? []).flatMap((step, index) => (step.uses ? [`${index}: ${step.uses.split('@')[0]}`] : []));
    expect(actions).toEqual(['0: actions/checkout']);
  });

  // A push to main and a pre-release tag such as v1.2.0-rc1 get no update file. The update helper accepts only a
  // version such as 1.2.0.
  const releaseTagOnly = "startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-')";
  const conditionOf = (job: WorkflowJob) => job.if?.replace(/\s+/g, ' ').trim();

  it('signs only for a release tag such as v1.2.0', () => {
    expect(conditionOf(sign)).toBe(releaseTagOnly);
  });

  // The release job runs after the sign job. Its own condition keeps it off a push to main, also when "needs" changes.
  it('adds the release files only for a release tag such as v1.2.0', () => {
    expect(conditionOf(release)).toBe(releaseTagOnly);
  });

  it('signs only after the publish job', () => {
    expect(needsOf(sign)).toContain('publish');
  });

  it('gives the sign job only the permissions that it needs', () => {
    expect(sign.permissions).toEqual({ contents: 'write', packages: 'read' });
  });

  it.each([
    ['publish', publish, (step: WorkflowStep) => step.uses?.startsWith('docker/build-push-action@') ?? false],
    ['sign', sign, (step: WorkflowStep) => step.run?.includes('make-update-file.sh') ?? false],
  ] as const)('checks in the %s job that the tag is on main, before it publishes or signs', (_name, job, isGuarded) => {
    const check = stepIndex(job, onMainCheck);
    const guarded = stepIndex(job, isGuarded);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(guarded).toBeGreaterThan(check);
    // merge-base needs the history of main
    expect(job.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
  });
});

describe('test runs', () => {
  // npm test runs each tools folder with test:tools. npm run coverage runs the projects of vitest.config.ts.
  // A tools folder with tests must be in both, or one of the two runs skips it.
  const toolsWithTests = readdirSync(join(ROOT, 'tools')).filter(name =>
    statSync(join(ROOT, 'tools', name)).isDirectory() &&
    readdirSync(join(ROOT, 'tools', name)).some(file => /\.test\.ts$/.test(file)),
  );
  const testTools = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['test:tools'];
  const projects = /projects:\s*\[([^\]]*)\]/.exec(read('vitest.config.ts'))?.[1] ?? '';

  it('finds the tools folders with tests', () => {
    expect(toolsWithTests).toContain('guardrails');
  });

  it.each(toolsWithTests)('runs tools/%s in npm test and in npm run coverage', name => {
    expect(testTools).toContain(`--root tools/${name}`);
    expect(projects).toContain(`'tools/${name}'`);
  });

  // npm test does not run the shell tests of the Pi card (they need Linux or Docker). Only a workflow runs them,
  // so a test script that no workflow names never runs. The *.lib.sh files and in-linux.sh are helpers, not tests.
  const PI_TESTS = 'tools/pi-image/test';
  const piTestScripts = readdirSync(join(ROOT, PI_TESTS)).filter(file => file.endsWith('.test.sh'));
  const workflows = readdirSync(join(ROOT, '.github/workflows'))
    .filter(file => /\.ya?ml$/.test(file))
    .map(file => read(join('.github/workflows', file)))
    .join('\n');

  it('finds the shell tests of the Pi card', () => {
    expect(piTestScripts).toContain('update-chatter-check.test.sh');
  });

  it.each(piTestScripts)(`runs ${PI_TESTS}/%s in a workflow`, file => {
    expect(workflows).toContain(`${PI_TESTS}/${file}`);
  });
});
