import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from './ChannelType.js';
import { ntfyChannel } from './ntfy.js';
import { fakeFetch, textOf, WARNING_MESSAGE as MESSAGE } from './testSupport.js';

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

  it('sends to the server address as the admin typed it, also under a path', async () => {
    expect((await sent(MESSAGE, { ...settings, url: 'https://ntfy.shop.local' })).request.url).toBe('https://ntfy.shop.local/');
    expect((await sent(MESSAGE, { ...settings, url: 'https://shop.local/ntfy' })).request.url).toBe('https://shop.local/ntfy');
    // A proxy under /ntfy/ answers a redirect for /ntfy, so Chatter keeps the slash
    expect((await sent(MESSAGE, { ...settings, url: 'https://shop.local/ntfy/' })).request.url).toBe('https://shop.local/ntfy/');
  });

  it('sends to ntfy.sh with no login when the server and the token are empty, as the form sends them', async () => {
    const { request } = await sent(MESSAGE, { ...settings, url: '', token: '' });

    expect(request.url).toBe('https://ntfy.sh/');
    expect(new Headers(request.init.headers).get('authorization')).toBeNull();
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

  it('hides only the whole topic in the reason of ntfy, not the same letters in other words', async () => {
    const answer = () => new Response(JSON.stringify({ error: 'invalid request: topic a is a bad topic' }), { status: 400 });

    expect(await ntfyChannel.send({ topic: 'a' }, MESSAGE, fakeFetch(answer).context()))
      .toEqual({ ok: false, retry: false, error: 'ntfy refused the message: invalid request: topic (topic) is (topic) bad topic.' });
  });

  it('hides the topic also in an address in the reason of ntfy', async () => {
    const answer = () => new Response(JSON.stringify({ error: `cannot publish to https://ntfy.sh/${TOPIC}/json` }), { status: 400 });

    expect(await ntfyChannel.send(settings, MESSAGE, fakeFetch(answer).context()))
      .toEqual({ ok: false, retry: false, error: 'ntfy refused the message: cannot publish to https://ntfy.sh/(topic)/json.' });
  });

  it('cuts a long reason of ntfy, and removes its period', async () => {
    expect(await resultFor(400, { error: `${'x'.repeat(300)}.` }))
      .toEqual({ ok: false, retry: false, error: `ntfy refused the message: ${'x'.repeat(200)}.` });
    expect(await resultFor(400, { error: 'invalid request.' }))
      .toEqual({ ok: false, retry: false, error: 'ntfy refused the message: invalid request.' });
  });

  it.each([null, { code: 40009 }, { error: '' }])('tells to check the server for a 400 with no reason: %j', async answer => {
    expect(await resultFor(400, answer)).toEqual({ ok: false, retry: false, error: 'ntfy answered 400. Check the server address.' });
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

    it('accepts an empty server and an empty token, as the form sends them', () => {
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

    it.each(['https://ntfy.sh/old-topic', 'https://ntfy.sh/old-topic/', 'https://ntfy.sh/v1/x'])(
      'refuses a path on ntfy.sh, because ntfy.sh takes the JSON only at its root: %s',
      url => {
        expect(firstProblem({ topic: TOPIC, url })).toBe('Remove the topic from the server address. Put only the topic in Topic.');
      },
    );

    it.each(['https://ntfy.sh', 'https://ntfy.sh/', 'https://ntfy.shop.local', 'https://shop.local/ntfy/'])('accepts the server %s', url => {
      expect(firstProblem({ topic: TOPIC, url })).toBeUndefined();
    });

    it.each([`https://ntfy.shop.local/${TOPIC}/`, `https://shop.local/ntfy/${TOPIC}`])('refuses the server %s, which ends with the topic', url => {
      expect(firstProblem({ topic: TOPIC, url })).toBe('Remove the topic from the server address. Put only the topic in Topic.');
    });

    it('refuses a token with spaces', () => {
      expect(firstProblem({ topic: TOPIC, token: 'tk_a b' })).toBe('Access token can have only plain letters, digits, and signs, with no spaces');
    });
  });
});
