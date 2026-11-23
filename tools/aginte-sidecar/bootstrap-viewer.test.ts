import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapViewer,
  loopbackOrigin,
  main,
  readBootstrapOptions,
  type BootstrapOptions,
  type FetchLike,
} from './bootstrap-viewer.js';

const ADMIN_PASSWORD = 'admin-secret-password';
const VIEWER_PASSWORD = 'viewer-secret-password';

const OPTIONS: BootstrapOptions = {
  url: 'http://127.0.0.1:3001',
  adminUsername: 'admin',
  adminPassword: ADMIN_PASSWORD,
  viewerUsername: 'aginte',
  viewerPassword: VIEWER_PASSWORD,
};

interface Reply {
  status?: number;
  body?: unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readBootstrapOptions', () => {
  it('uses the loopback default and reads the account variables', () => {
    expect(readBootstrapOptions({
      CHATTER_ADMIN_USERNAME: 'admin',
      CHATTER_ADMIN_PASSWORD: ADMIN_PASSWORD,
      CHATTER_VIEWER_USERNAME: 'aginte',
      CHATTER_VIEWER_PASSWORD: VIEWER_PASSWORD,
    })).toEqual(OPTIONS);
  });

  it('accepts localhost and ::1', () => {
    expect(loopbackOrigin('http://localhost:3001')).toBe('http://localhost:3001');
    expect(loopbackOrigin('http://[::1]:3001')).toBe('http://[::1]:3001');
    expect(loopbackOrigin('https://127.0.0.1:3001')).toBe('https://127.0.0.1:3001');
  });

  it('stops for a non-loopback address and keeps the password out of the error', () => {
    const secret = 'url-secret-password';
    expect(() => loopbackOrigin(`http://admin:${secret}@10.0.0.8:3001`)).toThrow(/loopback/);
    expect(() => loopbackOrigin('http://10.0.0.8:3001')).toThrow(/loopback/);
    expect(() => loopbackOrigin('https://example.com')).toThrow(/loopback/);
    try {
      loopbackOrigin(`http://admin:${secret}@10.0.0.8:3001`);
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
      expect(error instanceof Error ? error.message : '').not.toContain('Authorization');
    }
  });

  it('stops when a password has fewer than 8 characters', () => {
    expect(() => readBootstrapOptions({
      CHATTER_ADMIN_USERNAME: 'admin',
      CHATTER_ADMIN_PASSWORD: 'short',
      CHATTER_VIEWER_USERNAME: 'aginte',
      CHATTER_VIEWER_PASSWORD: VIEWER_PASSWORD,
    })).toThrow(/CHATTER_ADMIN_PASSWORD/);
  });
});

describe('bootstrapViewer', () => {
  it('makes the Admin and the viewer, then checks the viewer login', async () => {
    const seen = new FetchLog();
    const logs = captureLogs();
    await bootstrapViewer(OPTIONS, seen.fetch({
      'GET /api/auth/status': { body: { setupNeeded: true, loggedIn: false, user: null } },
      'POST /api/auth/setup': { body: { setupNeeded: false, loggedIn: true, user: { username: 'admin', role: 'admin' } } },
      'GET /api/settings/users': [
        { body: { users: [{ username: 'admin', role: 'admin' }] } },
        { body: { users: [{ username: 'admin', role: 'admin' }, { username: 'aginte', role: 'viewer' }] } },
      ],
      'POST /api/settings/users': { body: { users: [{ username: 'aginte', role: 'viewer' }] } },
      'GET /api/status': { body: { machines: [] } },
    }));

    expect(seen.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /api/auth/status',
      'POST /api/auth/setup',
      'GET /api/settings/users',
      'POST /api/settings/users',
      'GET /api/settings/users',
      'GET /api/status',
    ]);
    expect(headerCarries(seen.calls[2]?.authorization, 'admin', ADMIN_PASSWORD)).toBe(true);
    expect(headerCarries(seen.calls[5]?.authorization, 'aginte', VIEWER_PASSWORD)).toBe(true);
    expect(JSON.parse(seen.calls[3]?.body ?? '{}')).toEqual({
      username: 'aginte',
      password: VIEWER_PASSWORD,
      role: 'viewer',
    });
    expect(logs.join('\n')).toContain('Viewer account "aginte" is ready with role "viewer".');
    expect(logs.join('\n')).not.toContain(ADMIN_PASSWORD);
    expect(logs.join('\n')).not.toContain(VIEWER_PASSWORD);
    expect(logs.join('\n')).not.toContain('Authorization');
    expect(logs.join('\n')).not.toContain('Basic ');
  });

  it('ignores a 409 from setup when another start made the Admin first', async () => {
    const seen = new FetchLog();
    await bootstrapViewer(OPTIONS, seen.fetch({
      'GET /api/auth/status': { body: { setupNeeded: true } },
      'POST /api/auth/setup': { status: 409, body: { error: 'The account is already set up' } },
      'GET /api/settings/users': { body: { users: [{ username: 'aginte', role: 'viewer' }] } },
    }));
    expect(seen.calls.map(call => call.path)).toEqual(['/api/auth/status', '/api/auth/setup', '/api/settings/users']);
  });

  it('prints the ready line and exits when the viewer already exists', async () => {
    const logs = captureLogs();
    const seen = new FetchLog();
    await bootstrapViewer(OPTIONS, seen.fetch({
      'GET /api/auth/status': { body: { setupNeeded: false } },
      'GET /api/settings/users': { body: { users: [{ username: 'Aginte', role: 'viewer' }] } },
    }));
    expect(seen.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /api/auth/status',
      'GET /api/settings/users',
    ]);
    expect(logs).toEqual(['Viewer account "aginte" already present with role "viewer".']);
  });

  it('stops when the username has a role other than viewer', async () => {
    const logs = captureLogs();
    await expect(bootstrapViewer(OPTIONS, new FetchLog().fetch({
      'GET /api/auth/status': { body: { setupNeeded: false } },
      'GET /api/settings/users': { body: { users: [{ username: 'aginte', role: 'admin' }] } },
    }))).rejects.toThrow(/role "admin"/);
    expect(logs.join('\n')).not.toContain(VIEWER_PASSWORD);
    expect(logs.join('\n')).not.toContain('Authorization');
  });

  it('stops when a raced create leaves an operator account', async () => {
    await expect(bootstrapViewer(OPTIONS, new FetchLog().fetch({
      'GET /api/auth/status': { body: { setupNeeded: false } },
      'GET /api/settings/users': [
        { body: { users: [{ username: 'admin', role: 'admin' }] } },
        { body: { users: [{ username: 'aginte', role: 'operator' }] } },
      ],
      'POST /api/settings/users': { status: 409, body: { error: 'exists already' } },
    }))).rejects.toThrow(/role "operator"/);
  });

  it('stops when the viewer login does not work', async () => {
    await expect(bootstrapViewer(OPTIONS, new FetchLog().fetch({
      'GET /api/auth/status': { body: { setupNeeded: false } },
      'GET /api/settings/users': [
        { body: { users: [] } },
        { body: { users: [{ username: 'aginte', role: 'viewer' }] } },
      ],
      'POST /api/settings/users': { status: 201, body: { users: [{ username: 'aginte', role: 'viewer' }] } },
      'GET /api/status': { status: 401, body: { error: 'Unauthorized' } },
    }))).rejects.toThrow(/GET \/api\/status failed with status 401/);
  });

  it('stops for a non-loopback url before it sends a request', async () => {
    const seen = new FetchLog();
    await expect(bootstrapViewer({ ...OPTIONS, url: 'http://192.168.1.20:3001' }, seen.fetch({}))).rejects.toThrow(/loopback/);
    expect(seen.calls).toEqual([]);
  });
});

describe('main', () => {
  it('returns 0 and prints no password', async () => {
    const logs = captureLogs();
    const code = await main({
      CHATTER_URL: 'http://127.0.0.1:3001',
      CHATTER_ADMIN_USERNAME: 'admin',
      CHATTER_ADMIN_PASSWORD: ADMIN_PASSWORD,
      CHATTER_VIEWER_USERNAME: 'aginte',
      CHATTER_VIEWER_PASSWORD: VIEWER_PASSWORD,
    }, new FetchLog().fetch({
      'GET /api/auth/status': { body: { setupNeeded: false } },
      'GET /api/settings/users': { body: { users: [{ username: 'aginte', role: 'viewer' }] } },
    }));
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain(ADMIN_PASSWORD);
    expect(logs.join('\n')).not.toContain(VIEWER_PASSWORD);
    expect(logs.join('\n')).not.toContain('Authorization');
  });

  it('returns 1 for a public CHATTER_URL and prints no password', async () => {
    const logs = captureLogs();
    const code = await main({
      CHATTER_URL: 'http://10.1.1.1:3001',
      CHATTER_ADMIN_USERNAME: 'admin',
      CHATTER_ADMIN_PASSWORD: ADMIN_PASSWORD,
      CHATTER_VIEWER_USERNAME: 'aginte',
      CHATTER_VIEWER_PASSWORD: VIEWER_PASSWORD,
    }, new FetchLog().fetch({}));
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('loopback');
    expect(logs.join('\n')).not.toContain(ADMIN_PASSWORD);
    expect(logs.join('\n')).not.toContain('Authorization');
  });
});

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(message => {
    logs.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation(message => {
    logs.push(String(message));
  });
  return logs;
}

function headerCarries(header: string | undefined, username: string, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  return Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8') === `${username}:${password}`;
}

interface SeenCall {
  method: string;
  path: string;
  authorization?: string;
  body?: string;
}

class FetchLog {
  readonly calls: SeenCall[] = [];

  fetch(routes: Record<string, Reply | Reply[]>): FetchLike {
    const queues = new Map<string, Reply[]>();
    for (const [key, reply] of Object.entries(routes)) {
      queues.set(key, Array.isArray(reply) ? [...reply] : [reply]);
    }
    return async (url, init) => {
      const method = init?.method ?? 'GET';
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      this.calls.push({
        method,
        path,
        authorization: headers.get('Authorization') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const queue = queues.get(`${method} ${path}`);
      const reply = queue?.shift();
      if (!reply) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    };
  }
}
