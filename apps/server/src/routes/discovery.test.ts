import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { LoggedInEnv } from '../auth/authRoutes.js';
import { INSTANCE_ID } from '../diagnostics/instance.js';
import { NetworkScanner } from '../discovery/NetworkScanner.js';
import { HardwarePoller } from '../polling/poller.js';
import { discoveryRoutes } from './discovery.js';

/** The discovery routes for a logged-in admin, with a scanner that finds three Chatter servers */
function appWithChatters() {
  const scanner = new NetworkScanner(async host => {
    if (host === '10.0.0.5') return { machines: [], chatter: { host, version: '1.2.0', instance: 'aaaaaaaaaaaaaaaa' } };
    if (host === '10.0.0.6') return { machines: [], chatter: { host, version: '1.3.0', instance: INSTANCE_ID } };
    if (host === '10.0.0.7') return { machines: [], chatter: { host, version: 'development' } };
    return { machines: [], chatter: null };
  });
  return new Hono<LoggedInEnv>()
    .use(async (c, next) => {
      c.set('user', { id: 1, username: 'admin', role: 'admin' });
      await next();
    })
    .route('/', discoveryRoutes(new HardwarePoller(new Database(':memory:')), scanner));
}

describe('POST /discovery/scan', () => {
  it('lists the other Chatter servers, but not this one (its instance name, or the address of this page)', async () => {
    const res = await appWithChatters().request('/discovery/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Host: '10.0.0.7:3001' }, body: '{"range":"10.0.0"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ range: '10.0.0', found: [], otherChatters: [{ host: '10.0.0.5', version: '1.2.0' }] });
  });
});
