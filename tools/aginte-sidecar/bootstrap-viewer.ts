import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_URL = 'http://127.0.0.1:3001';

export interface BootstrapOptions {
  url: string;
  adminUsername: string;
  adminPassword: string;
  viewerUsername: string;
  viewerPassword: string;
}

/** Node 22 fetch. Tests pass a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ListedUser {
  username: string;
  role: string;
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** Read the bootstrap settings from the environment. Passwords stay out of argv. */
export function readBootstrapOptions(env: NodeJS.ProcessEnv): BootstrapOptions {
  return {
    url: loopbackOrigin(env.CHATTER_URL?.trim() || DEFAULT_URL),
    adminUsername: requiredText(env.CHATTER_ADMIN_USERNAME, 'CHATTER_ADMIN_USERNAME'),
    adminPassword: requiredPassword(env.CHATTER_ADMIN_PASSWORD, 'CHATTER_ADMIN_PASSWORD'),
    viewerUsername: requiredText(env.CHATTER_VIEWER_USERNAME, 'CHATTER_VIEWER_USERNAME'),
    viewerPassword: requiredPassword(env.CHATTER_VIEWER_PASSWORD, 'CHATTER_VIEWER_PASSWORD'),
  };
}

/**
 * Make the first Admin when Chatter still needs one, then make a viewer account.
 * When that username already has role "viewer", this returns without a change.
 * When that username has another role, this throws and leaves the account unchanged.
 */
export async function bootstrapViewer(options: BootstrapOptions, fetchImpl: FetchLike = fetch): Promise<void> {
  const url = loopbackOrigin(options.url);
  const adminUsername = requiredText(options.adminUsername, 'CHATTER_ADMIN_USERNAME');
  const adminPassword = requiredPassword(options.adminPassword, 'CHATTER_ADMIN_PASSWORD');
  const viewerUsername = requiredText(options.viewerUsername, 'CHATTER_VIEWER_USERNAME');
  const viewerPassword = requiredPassword(options.viewerPassword, 'CHATTER_VIEWER_PASSWORD');

  const status = await call(fetchImpl, `${url}/api/auth/status`);
  if (status.code !== 200) throw new BootstrapError(`GET /api/auth/status failed with status ${status.code}.`);
  if (readSetupNeeded(status.body)) {
    const setup = await call(fetchImpl, `${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    if (setup.code !== 200 && setup.code !== 201 && setup.code !== 409) {
      throw new BootstrapError(`POST /api/auth/setup failed with status ${setup.code}.`);
    }
  }

  const users = await listUsers(fetchImpl, url, adminUsername, adminPassword);
  if (viewerState(users, viewerUsername) === 'present') {
    console.log(`Viewer account "${viewerUsername}" already present with role "viewer".`);
    return;
  }

  const created = await call(fetchImpl, `${url}/api/settings/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicHeader(adminUsername, adminPassword),
    },
    body: JSON.stringify({ username: viewerUsername, password: viewerPassword, role: 'viewer' }),
  });
  if (created.code !== 200 && created.code !== 201 && created.code !== 409) {
    throw new BootstrapError(`POST /api/settings/users failed with status ${created.code}.`);
  }

  const afterCreate = await listUsers(fetchImpl, url, adminUsername, adminPassword);
  if (viewerState(afterCreate, viewerUsername) !== 'present') {
    throw new BootstrapError(`Chatter has no viewer account "${viewerUsername}".`);
  }

  const check = await call(fetchImpl, `${url}/api/status`, {
    headers: { Authorization: basicHeader(viewerUsername, viewerPassword) },
  });
  if (check.code !== 200) throw new BootstrapError(`GET /api/status failed with status ${check.code}.`);
  console.log(`Viewer account "${viewerUsername}" is ready with role "viewer".`);
}

export async function main(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Promise<number> {
  try {
    await bootstrapViewer(readBootstrapOptions(env), fetchImpl);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Viewer bootstrap failed.');
    return 1;
  }
}

function startedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (startedAsCli()) {
  main().then(code => {
    process.exit(code);
  });
}

function requiredText(value: string | undefined, name: string): string {
  const text = value?.trim() ?? '';
  if (text.length === 0) throw new BootstrapError(`${name} is required.`);
  if (text.includes(':')) throw new BootstrapError(`${name} must omit the colon character.`);
  return text;
}

function requiredPassword(value: string | undefined, name: string): string {
  if (value === undefined || value.length < MIN_PASSWORD_LENGTH) {
    throw new BootstrapError(`${name} must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

/** Accept only an http(s) loopback origin. A public address stops the script. */
export function loopbackOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new BootstrapError('CHATTER_URL must be a loopback http address.');
  }
  return parsed.origin;
}

function isLoopbackHost(hostname: string): boolean {
  // Node reports an IPv6 hostname with brackets, for example "[::1]".
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some(number => !Number.isInteger(number) || number < 0 || number > 255)) return false;
  return numbers[0] === 127;
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function listUsers(fetchImpl: FetchLike, url: string, username: string, password: string): Promise<ListedUser[]> {
  const response = await call(fetchImpl, `${url}/api/settings/users`, {
    headers: { Authorization: basicHeader(username, password) },
  });
  if (response.code !== 200) throw new BootstrapError(`GET /api/settings/users failed with status ${response.code}.`);
  return usersFrom(response.body);
}

function readSetupNeeded(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('setupNeeded' in body)) return false;
  return body.setupNeeded === true;
}

function usersFrom(body: unknown): ListedUser[] {
  if (!body || typeof body !== 'object' || !('users' in body) || !Array.isArray(body.users)) {
    throw new BootstrapError('GET /api/settings/users returned an unexpected reply.');
  }
  return body.users.map(user => {
    if (!user || typeof user !== 'object' || typeof user.username !== 'string' || typeof user.role !== 'string') {
      throw new BootstrapError('GET /api/settings/users returned an unexpected reply.');
    }
    return { username: user.username, role: user.role };
  });
}

/** "present" when the username has role viewer. Another role stops the script. */
function viewerState(users: ListedUser[], username: string): 'absent' | 'present' {
  const found = users.find(user => user.username.toLowerCase() === username.toLowerCase());
  if (!found) return 'absent';
  if (found.role !== 'viewer') {
    throw new BootstrapError(`Account "${found.username}" has role "${found.role}". The Aginte reader must use role "viewer".`);
  }
  return 'present';
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<{ code: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch {
    throw new BootstrapError('Chatter did not answer.');
  }
  const text = await response.text();
  if (text === '') return { code: response.status, body: null };
  try {
    return { code: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new BootstrapError('Chatter returned a reply that is not JSON.');
  }
}
