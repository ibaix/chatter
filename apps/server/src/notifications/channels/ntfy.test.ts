import { describe, expect, it } from 'vitest';
import type { OutgoingMessage, SendContext, SendResult } from './ChannelType.js';
import { ntfyChannel } from './ntfy.js';

const MESSAGE: OutgoingMessage = {
  kind: 'started',
  text: 'WARNING - Haas ST-10: Idle for 20 minutes. Started 9:40 AM.',
  severity: 'warning',
  machine: { id: 'haas-st10', name: 'Haas ST-10' },
  alertName: 'Idle for 20 minutes',
  summary: 'Idle for 20 min or more',
  startedAt: '2026-11-13T15:40:00.000Z',
  endedAt: null,
  link: 'http://chatter.local:3001/machine/haas-st10',
};

interface SentRequest {
  url: string;
  init: RequestInit;
}

/** A fetch that keeps each request and gives the answer of `answer` */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const requests: SentRequest[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return answer();
  }) as typeof globalThis.fetch;
  return { requests, context: (): SendContext => ({ fetch, signal: new AbortController().signal }) };
}

const TOPIC = 'chatter-x7k2p9';
const TOKEN = 'tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2';
const settings = { topic: TOPIC };

async function sent(message: OutgoingMessage, values: Parameters<typeof ntfyChannel.send>[0] = settings) {
  const service = fakeFetch(() => new Response('{"id":"abc"}', { status: 200 }));
  const result = await ntfyChannel.send(values, message, service.context());
  return { result, request: service.requests[0], body: JSON.parse(String(service.requests[0].init.body)) };
}

async function resultFor(status: number, answer: unknown = null) {
  const body = answer === null ? null : JSON.stringify(answer);
  return ntfyChannel.send({ ...settings, token: TOKEN }, MESSAGE, fakeFetch(() => new Response(body, { status })).context());
}

function firstProblem(values: unknown): string | undefined {
  return ntfyChannel.settings.safeParse(values).error?.issues[0].message;
}

function textOf(result: SendResult): string {
  return result.ok ? result.detail : result.error;
}

describe('ntfyChannel', () => {
  it('asks for the server, a topic that stays secret, and an access token that stays secret', () => {
    expect(ntfyChannel.fields.map(field => [field.key, field.label, field.kind, field.required])).toEqual([
      ['topic', 'Topic', 'secret', true],
      ['url', 'Server (optional)', 'url', false],
      ['token', 'Access token (optional)', 'secret', false],
    ]);
    expect(ntfyChannel.fields[1].hint).toContain('https://ntfy.sh');
  });

  it('tells the admin to subscribe to the topic in the ntfy app', () => {
    expect(ntfyChannel.note).toContain('ntfy app');
  });

  it('sends JSON to ntfy.sh when the server is empty', async () => {
    const { result, request, body } = await sent(MESSAGE);

    expect(result).toEqual({ ok: true, detail: 'ntfy sent it' });
    expect(request.url).toBe('https://ntfy.sh/');
    expect(request.init.method).toBe('POST');
    expect(request.init.redirect).toBe('manual');
    expect(new Headers(request.init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(request.init.headers).get('authorization')).toBeNull();
    expect(body).toEqual({
      topic: TOPIC,
      title: 'Chatter: Haas ST-10',
      message: MESSAGE.text,
      priority: 4,
      tags: ['warning'],
      click: 'http://chatter.local:3001/machine/haas-st10',
    });
  });

  it('sends to the root of a server of the shop, also under a path', async () => {
    expect((await sent(MESSAGE, { ...settings, url: 'https://ntfy.shop.local' })).request.url).toBe('https://ntfy.shop.local/');
    expect((await sent(MESSAGE, { ...settings, url: 'https://shop.local/ntfy/' })).request.url).toBe('https://shop.local/ntfy');
  });

  it('sends the access token as a Bearer token', async () => {
    const { request } = await sent(MESSAGE, { ...settings, token: TOKEN });

    expect(new Headers(request.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ['a critical alert', { kind: 'started', severity: 'critical' }, 5, ['rotating_light']],
    ['a warning alert', { kind: 'started', severity: 'warning' }, 4, ['warning']],
    ['an alert with no level', { kind: 'started', severity: null }, 4, ['warning']],
    ['combined alerts', { kind: 'combined', severity: 'critical' }, 5, ['rotating_light']],
    ['an alert that ended', { kind: 'ended', severity: 'critical' }, 3, ['white_check_mark']],
    ['"And 7 more alerts"', { kind: 'more', severity: null }, 4, ['warning']],
    ['a test', { kind: 'test', severity: null }, 3, ['bell']],
  ] as const)('gives %s its priority and tag', async (_name, change, priority, tags) => {
    const { body } = await sent({ ...MESSAGE, ...change });

    expect(body.priority).toBe(priority);
    expect(body.tags).toEqual(tags);
  });

  it('uses the title "Chatter" for a message with no machine, and sends no click without a link', async () => {
    const { body } = await sent({ ...MESSAGE, kind: 'test', machine: null, link: null });

    expect(body.title).toBe('Chatter');
    expect(body).not.toHaveProperty('click');
  });

  it.each([401, 403])('stops at once when ntfy answers %i, because the token cannot write to the topic', async status => {
    expect(await resultFor(status)).toEqual({
      ok: false, retry: false,
      error: 'ntfy refused the access. Check the access token, and that it can write to the topic.',
    });
  });

  it('stops at once when the message is too long for ntfy', async () => {
    expect(await resultFor(413)).toEqual({ ok: false, retry: false, error: 'ntfy refused the message because it is too long.' });
  });

  it('gives the reason of ntfy for a 400, without the topic and the token', async () => {
    const result = await resultFor(400, { code: 40009, http: 400, error: `invalid request: topic ${TOPIC} with ${TOKEN}` });

    expect(result).toEqual({ ok: false, retry: false, error: 'ntfy refused the message: invalid request: topic (topic) with (access token).' });
  });

  it('tells to check the server for another refusal', async () => {
    expect(await resultFor(404)).toEqual({ ok: false, retry: false, error: 'ntfy answered 404. Check the server address.' });
  });

  it.each([408, 429, 500, 507])('tries again later when ntfy answers %i', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: true, error: `ntfy answered ${status}. Chatter tries again later.` });
  });

  it('stops at once for a redirect', async () => {
    expect(await resultFor(301))
      .toEqual({ ok: false, retry: false, error: 'ntfy answered 301 and points to another address. Use the new address.' });
  });

  it('tries again later when Chatter cannot reach the server', async () => {
    const refused = fakeFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });

    expect(await ntfyChannel.send(settings, MESSAGE, refused.context()))
      .toEqual({ ok: false, retry: true, error: 'Chatter could not reach the ntfy server (ECONNREFUSED).' });
  });

  it.each([200, 301, 400, 401, 403, 404, 413, 429, 500])('keeps the topic and the token out of the text for answer %i', async status => {
    const text = textOf(await resultFor(status));

    expect(text).not.toContain(TOPIC);
    expect(text).not.toContain(TOKEN);
  });

  describe('settings', () => {
    it('accepts a topic alone, and removes the spaces', () => {
      expect(ntfyChannel.settings.parse({ topic: ` ${TOPIC} ` })).toEqual({ topic: TOPIC });
    });

    it('accepts a server of the shop and a token', () => {
      expect(ntfyChannel.settings.safeParse({ topic: TOPIC, url: 'http://192.168.1.20:8080', token: TOKEN }).success).toBe(true);
    });

    it('treats an empty server and an empty token as not set', () => {
      expect(ntfyChannel.settings.parse({ topic: TOPIC, url: '', token: '' })).toEqual({ topic: TOPIC, url: '', token: '' });
    });

    it.each([undefined, '', 'has space', 'a/b', 'x'.repeat(65), 'ä-topic'])('refuses the topic %s', topic => {
      expect(firstProblem({ topic })).toBe('Topic can have only letters, digits, - and _, up to 64 characters');
    });

    it.each(['ntfy.sh', 'ftp://ntfy.sh'])('refuses the server %s', url => {
      expect(firstProblem({ topic: TOPIC, url })).toBe('Server must start with http:// or https://');
    });

    it('refuses a server with a login in it', () => {
      expect(firstProblem({ topic: TOPIC, url: 'https://me:pw@ntfy.shop.local' }))
        .toBe('Remove the user name and password from the server address. Put an access token in Access token.');
    });

    it('refuses a server address that ends with the topic', () => {
      expect(firstProblem({ topic: TOPIC, url: `https://ntfy.sh/${TOPIC}` }))
        .toBe('Remove the topic from the server address. Put only the topic in Topic.');
    });

    it('refuses a token with spaces', () => {
      expect(firstProblem({ topic: TOPIC, token: 'tk_a b' })).toBe('Access token can have only plain letters, digits, and signs, with no spaces');
    });
  });
});
