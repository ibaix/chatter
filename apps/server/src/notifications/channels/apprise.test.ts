import { describe, expect, it } from 'vitest';
import { appriseChannel } from './apprise.js';
import type { OutgoingMessage } from './ChannelType.js';
import { BUSY, fakeFetch, TOO_MANY } from './testSupport.js';

const MESSAGE: OutgoingMessage = {
  kind: 'started',
  text: 'CRITICAL - Haas VF-2: Spindle load above 80%. Spindle load is 92%. Started 9:02 AM.',
  severity: 'critical',
  machine: { id: 'haas-vf2', name: 'Haas VF-2' },
  alertName: 'Spindle load above 80%',
  summary: 'Spindle load is 92%',
  startedAt: '2026-11-16T15:02:00.000Z',
  endedAt: null,
  link: 'http://chatter.local:3001/machine/haas-vf2',
};

const URL_WITH_KEY = 'http://apprise.local:8000/notify/chatter';
const settings = { url: URL_WITH_KEY, tag: '', username: '', password: '' };

async function sendAndGetBody(message: OutgoingMessage, values = settings) {
  const service = fakeFetch(() => new Response(null, { status: 200 }));
  await appriseChannel.send(values, message, service.context());
  return JSON.parse(String(service.requests[0].init.body));
}

async function resultFor(status: number) {
  return appriseChannel.send(settings, MESSAGE, fakeFetch(() => new Response(null, { status })).context());
}

function firstProblem(values: unknown): string | undefined {
  return appriseChannel.settings.safeParse(values).error?.issues[0].message;
}

describe('appriseChannel', () => {
  it('asks for the Apprise address, and a tag and a login that are not necessary', () => {
    expect(appriseChannel.fields.map(field => [field.key, field.kind, field.required])).toEqual([
      ['url', 'url', true],
      ['tag', 'text', false],
      ['username', 'text', false],
      ['password', 'secret', false],
    ]);
  });

  it('puts the login under Advanced, because Apprise asks for it only when it has a login, and keeps the tag in view', () => {
    expect(appriseChannel.fields.filter(field => field.advanced).map(field => field.key)).toEqual(['username', 'password']);
  });

  it('tells the admin before they start that Apprise runs on another computer, with a saved config key', () => {
    expect(appriseChannel.note).toContain('config key');
    expect(appriseChannel.note).toContain('64-bit');
  });

  it('waits longer than other types, because Apprise answers only after it sent to each service', () => {
    expect(appriseChannel.timeoutMs).toBe(60_000);
  });

  it('sends the message text as JSON to the address with the config key', async () => {
    const service = fakeFetch(() => new Response('', { status: 200 }));

    const result = await appriseChannel.send(settings, MESSAGE, service.context());

    expect(result).toEqual({ ok: true, detail: 'Apprise sent it' });
    expect(service.requests).toHaveLength(1);
    const [{ url, init }] = service.requests;
    expect(url).toBe(URL_WITH_KEY);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Chatter: Haas VF-2',
      body: MESSAGE.text,
      type: 'failure',
      format: 'text',
    });
  });

  it('gives the signal of the context to fetch, so a slow Apprise stops after the time limit', async () => {
    const service = fakeFetch(() => new Response(null, { status: 200 }));
    const context = service.context();

    await appriseChannel.send(settings, MESSAGE, context);

    expect(service.requests[0].init.signal).toBe(context.signal);
  });

  it('gives the title "Chatter" to a message that is not about one machine', async () => {
    expect((await sendAndGetBody({ ...MESSAGE, kind: 'more', severity: null, machine: null })).title).toBe('Chatter');
  });

  it.each<[string, Partial<OutgoingMessage>, string]>([
    ['a critical start', { kind: 'started', severity: 'critical' }, 'failure'],
    ['a warning start', { kind: 'started', severity: 'warning' }, 'warning'],
    ['a start with no level', { kind: 'started', severity: null }, 'warning'],
    ['a critical start and end', { kind: 'combined', severity: 'critical' }, 'failure'],
    ['a warning start and end', { kind: 'combined', severity: 'warning' }, 'warning'],
    ['an end', { kind: 'ended', severity: 'critical' }, 'success'],
    ['an "And N more" message', { kind: 'more', severity: null }, 'warning'],
    ['a test', { kind: 'test', severity: null }, 'info'],
  ])('gives %s the Apprise type %s', async (_name, change, type) => {
    expect((await sendAndGetBody({ ...MESSAGE, ...change })).type).toBe(type);
  });

  it('sends the tag, so Apprise sends only to the services with that tag', async () => {
    expect((await sendAndGetBody(MESSAGE, { ...settings, tag: 'shop-floor' })).tag).toBe('shop-floor');
  });

  it('sends the login of Apprise in the Authorization header', async () => {
    const service = fakeFetch(() => new Response(null, { status: 200 }));

    await appriseChannel.send({ ...settings, username: 'chatter', password: 'pässword' }, MESSAGE, service.context());

    const expected = `Basic ${Buffer.from('chatter:pässword', 'utf8').toString('base64')}`;
    expect(new Headers(service.requests[0].init.headers).get('authorization')).toBe(expected);
  });

  it('sends a password with no user name, because Apprise allows only a password', async () => {
    const service = fakeFetch(() => new Response(null, { status: 200 }));

    await appriseChannel.send({ ...settings, password: 'secret' }, MESSAGE, service.context());

    expect(new Headers(service.requests[0].init.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from(':secret').toString('base64')}`);
  });

  it('does not try again when Apprise answers 424, because some services can have the message already', async () => {
    expect(await resultFor(424)).toEqual({
      ok: false,
      retry: false,
      error: 'Apprise could not send to one service or more, or no service has the tag. Look in the Apprise log.',
    });
  });

  it.each<[number, string]>([
    [404, 'Apprise has no config with this key. Check the address.'],
    [401, 'Apprise refused the login. Check the user name and password.'],
    [403, 'Apprise refused the request. Check the tag and the access of the config.'],
    [400, 'Apprise answered 400. Check the address.'],
    [304, 'Apprise answered 304. Check the address.'],
  ])('stops at once when Apprise answers %i, and tells what to check', async (status, error) => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: false, error });
  });

  it('stops at once when Apprise sends Chatter to another address', async () => {
    const moved = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://apprise.local/notify/chatter' } }));

    expect(await appriseChannel.send(settings, MESSAGE, moved.context()))
      .toEqual({ ok: false, retry: false, error: 'Apprise answered 302 and points to another address. Use the new address.' });
  });

  it.each([[408, BUSY], [429, TOO_MANY], [500, BUSY], [503, BUSY]])('tries again later when Apprise answers %i (busy or a problem)', async (status, ending) => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: true, error: `Apprise answered ${status}${ending}` });
  });

  it('tries again later when Chatter cannot reach Apprise', async () => {
    const refused = fakeFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });

    expect(await appriseChannel.send(settings, MESSAGE, refused.context()))
      .toEqual({ ok: false, retry: true, error: 'Chatter could not reach Apprise (ECONNREFUSED).' });
  });

  it('keeps the password and the config key out of the error, also when the network error text has them', async () => {
    const PASSWORD = 'password-for-tests';
    const KEY = 'private-key-for-tests';
    const privateSettings = { ...settings, url: `http://apprise.local:8000/notify/${KEY}`, username: 'chatter', password: PASSWORD };
    const failed = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${privateSettings.url} as chatter:${PASSWORD}`, { cause: { code: 'ECONNREFUSED' } });
    });

    const result = await appriseChannel.send(privateSettings, MESSAGE, failed.context());

    expect(result).toEqual({ ok: false, retry: true, error: 'Chatter could not reach Apprise (ECONNREFUSED).' });
  });

  it('gives the result of the send, also when Chatter cannot close the answer', async () => {
    const response = new Response('ok', { status: 200 });
    response.body!.cancel = () => Promise.reject(new Error('the time limit ended'));

    expect(await appriseChannel.send(settings, MESSAGE, fakeFetch(() => response).context()))
      .toEqual({ ok: true, detail: 'Apprise sent it' });
  });

  describe('settings', () => {
    it('accepts an address with a config key, with or without a tag and a login', () => {
      expect(appriseChannel.settings.safeParse({ url: URL_WITH_KEY }).success).toBe(true);
      expect(appriseChannel.settings.safeParse({ url: 'https://apprise.example.com/notify/shop_1/', tag: 'office, floor', username: 'a', password: 'b' }).success)
        .toBe(true);
    });

    it.each([undefined, '', 'apprise.local:8000/notify/chatter', 'ftp://apprise.local/notify/chatter'])(
      'refuses the address %s, which is missing, not a web address, or not http or https',
      url => {
        expect(firstProblem({ url })).toBe('Apprise address must start with http:// or https://');
      },
    );

    it('accepts an address under a longer path, for Apprise behind a proxy', () => {
      expect(appriseChannel.settings.safeParse({ url: 'https://tools.example.com/apprise/notify/chatter' }).success).toBe(true);
    });

    it.each(['http://apprise.local:8000', 'http://apprise.local:8000/notify/', 'http://apprise.local:8000/notify/a/b', 'http://apprise.local:8000/cfg/chatter'])(
      'refuses the address %s, which has no config key after /notify/',
      url => {
        expect(firstProblem({ url }))
          .toBe('Apprise address must end with /notify/ and your config key, for example http://apprise.local:8000/notify/chatter');
      },
    );

    it('refuses an address with a user name or password in it, and tells where the login goes', () => {
      expect(firstProblem({ url: 'http://user:pass@apprise.local:8000/notify/chatter' }))
        .toBe('Remove the user name and password from the address. Put them in User name and Password.');
    });

    it('refuses a tag with other signs', () => {
      expect(firstProblem({ url: URL_WITH_KEY, tag: 'floor;rm' })).toBe('Tag can have only letters, digits, -, _, commas, and spaces');
    });

    it('refuses a user name with a colon, because the login cannot carry it', () => {
      expect(firstProblem({ url: URL_WITH_KEY, username: 'a:b' })).toBe('User name cannot have a colon (:)');
    });

    it('sends no tag and no login when they are blank', async () => {
      const service = fakeFetch(() => new Response(null, { status: 200 }));
      const parsed = appriseChannel.settings.parse({ url: URL_WITH_KEY, tag: '  ', username: ' ', password: '' });

      await appriseChannel.send(parsed, MESSAGE, service.context());

      expect(JSON.parse(String(service.requests[0].init.body))).not.toHaveProperty('tag');
      expect(new Headers(service.requests[0].init.headers).has('authorization')).toBe(false);
    });
  });
});
