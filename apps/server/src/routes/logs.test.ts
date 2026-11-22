import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/authRoutes.js';
import { loggedInAuth } from '../auth/testSupport.js';
import type { Auth } from '../auth/Auth.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { configureLogging, createLogger, currentLogLevel } from '../logging/logger.js';
import { LogBuffer } from '../logging/LogBuffer.js';
import { ServerLog } from '../logging/ServerLog.js';
import { LOG_STREAM_QUEUE, MAX_LOG_STREAMS } from './logs.js';
import { errorOf, testApp } from './testSupport.js';

/** Reads server-sent events from a reply, one at a time */
function eventReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    /** The next event: its name and its data */
    async next(): Promise<{ event: string; data: string }> {
      for (;;) {
        const end = text.indexOf('\n\n');
        if (end >= 0) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          if (block.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = [...block.matchAll(/^data: ?(.*)$/gm)].map(match => match[1]).join('\n');
          return { event, data };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream ended');
        text += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

describe('log routes', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let cookie: string;
  let operatorCookie: string;
  let serverLog: ServerLog;
  let stopListening: () => void;
  let restoreLogging: () => void;

  beforeAll(async () => {
    ({ auth, accounts, cookie } = await loggedInAuth());
    const login = { username: 'operator', password: 'test-password' };
    await accounts.add({ ...login, role: 'operator' });
    operatorCookie = `${SESSION_COOKIE}=${await auth.logIn(login, { userAgent: 'test browser', address: '127.0.0.1' })}`;
  });

  beforeEach(() => {
    const old = configureLogging({ level: 'info', format: 'text', sink: () => {} });
    restoreLogging = () => configureLogging(old);
    serverLog = new ServerLog(null, undefined, new LogBuffer({ lines: 2000, characters: 600_000, lineCharacters: 4000 }));
    stopListening = serverLog.listen();
  });

  afterEach(() => {
    serverLog.debug.turnOff('test');
    stopListening();
    restoreLogging();
  });

  const app = () => testApp({ auth, accounts, serverLog });
  const get = (path: string, as = cookie) => app().request(path, { headers: { Cookie: as } });

  it('only an admin can read the log', async () => {
    for (const path of ['/api/logs', '/api/logs/stream', '/api/logs/debug']) {
      expect((await get(path, operatorCookie)).status, path).toBe(403);
    }
    expect((await app().request('/api/logs')).status).toBe(401);
  });

  describe('GET /logs', () => {
    it('gives the kept lines as a text file, with the secrets hidden', async () => {
      createLogger('machines').child({ machine: 'm1' }).warn('Machine went offline', { reason: 'Connection refused' });
      createLogger('notifications').error('Send failed', { token: 'abc123', url: 'https://x.test/h?key=k9' });

      const res = await get('/api/logs');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="chatter-log-[0-9T-]+Z\.txt"$/);
      const text = await res.text();
      expect(text).toContain('[machines] Machine went offline machine=m1');
      expect(text).toContain('[notifications] Send failed');
      expect(text).not.toMatch(/abc123|k9/);
    });

    it('gives only the lines of a level, a machine, and a time', async () => {
      createLogger('machines').child({ machine: 'm1' }).info('m1 info');
      createLogger('machines').child({ machine: 'm1' }).warn('m1 warn');
      createLogger('machines').child({ machine: 'm2' }).warn('m2 warn');

      const text = await (await get('/api/logs?level=warn&machine=m1')).text();
      expect(text).toContain('m1 warn');
      expect(text).not.toMatch(/m1 info|m2 warn/);

      const future = new Date(Date.now() + 60_000).toISOString();
      expect(await (await get(`/api/logs?since=${future}`)).text()).toBe('');
    });

    it('refuses a level that is not a level', async () => {
      const res = await get('/api/logs?level=loud');
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('level must be debug, info, warn or error');
    });
  });

  describe('GET /logs/stream', () => {
    it('sends the last lines, then each new line of the filter', async () => {
      createLogger('machines').child({ machine: 'm1' }).warn('before');
      const res = await get('/api/logs/stream?machine=m1');
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');
      const events = eventReader(res);

      expect(await events.next()).toEqual({ event: 'line', data: expect.stringContaining('before') });
      createLogger('machines').child({ machine: 'm2' }).warn('other machine');
      createLogger('machines').child({ machine: 'm1' }).warn('after');
      expect(await events.next()).toEqual({ event: 'line', data: expect.stringContaining('after') });
      await events.cancel();
    });

    it('drops the lines that a slow browser cannot take, and tells how many', async () => {
      const res = await get('/api/logs/stream');
      const events = eventReader(res);
      // The browser reads nothing while 250 lines come
      for (let index = 0; index < LOG_STREAM_QUEUE + 50; index++) createLogger('x').info(`line ${index}`);

      const received: { event: string; data: string }[] = [];
      for (let index = 0; index < LOG_STREAM_QUEUE + 1; index++) received.push(await events.next());
      await events.cancel();
      const dropped = received.find(event => event.event === 'dropped');
      expect(dropped).toBeDefined();
      expect(Number(dropped!.data)).toBeGreaterThan(0);
      expect(received.filter(event => event.event === 'line').length).toBe(LOG_STREAM_QUEUE);
    });

    it(`allows at most ${MAX_LOG_STREAMS} live logs at the same time, and frees a place when one closes`, async () => {
      const open = [];
      for (let index = 0; index < MAX_LOG_STREAMS; index++) {
        const res = await get('/api/logs/stream');
        expect(res.status).toBe(200);
        open.push(eventReader(res));
      }
      const refused = await get('/api/logs/stream');
      expect(refused.status).toBe(429);

      await open[0].cancel();
      // The stream ends when its next wait ends: a new line wakes it
      createLogger('x').info('wake');
      await new Promise(resolve => setTimeout(resolve, 20));
      const again = await get('/api/logs/stream');
      expect(again.status).toBe(200);
      for (const events of [...open.slice(1), eventReader(again)]) await events.cancel();
    });
  });

  describe('debug level', () => {
    it('turns on for a time, and off again', async () => {
      const turnOn = await app().request('/api/logs/debug', {
        method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"on":true}',
      });
      const { debugUntil } = await turnOn.json() as { debugUntil: string };
      expect(Date.parse(debugUntil) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(currentLogLevel()).toBe('debug');
      expect(await (await get('/api/logs/debug')).json()).toEqual({ debugUntil });
      expect(serverLog.buffer.text()).toContain('Debug level on user=admin');

      const turnOff = await app().request('/api/logs/debug', {
        method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"on":false}',
      });
      expect(await turnOff.json()).toEqual({ debugUntil: null });
      expect(currentLogLevel()).toBe('info');
    });

    it('an operator cannot turn it on', async () => {
      const res = await app().request('/api/logs/debug', {
        method: 'PUT', headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' }, body: '{"on":true}',
      });
      expect(res.status).toBe(403);
      expect(currentLogLevel()).toBe('info');
      expect(serverLog.debug.state).toEqual({ debugUntil: null });
    });
  });
});
