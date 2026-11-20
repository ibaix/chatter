import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from './ChannelType.js';
import { discordChannel } from './discord.js';
import { fakeFetch, textOf, WARNING_MESSAGE as MESSAGE } from './testSupport.js';

const TOKEN = 'token-for-tests_abc-123';
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const settings = { url: WEBHOOK };
const BAD_URL = 'Webhook address must start with https://discord.com/api/webhooks/';
const BAD_MENTION = 'Mention can have only @everyone, @here, <@USER_ID>, and <@&ROLE_ID>, with a space between them';
const NO_MENTIONS = { parse: [], roles: [], users: [] };
const AMBER = 0xf1c40f;

async function sendAndGetBody(message: OutgoingMessage) {
  const service = fakeFetch(() => new Response(null, { status: 204 }));
  await discordChannel.send(settings, message, service.context());
  return JSON.parse(String(service.requests[0].init.body));
}

async function resultFor(status: number) {
  return discordChannel.send(settings, MESSAGE, fakeFetch(() => new Response(null, { status })).context());
}

function firstProblem(values: unknown): string | undefined {
  return discordChannel.settings.safeParse(values).error?.issues[0].message;
}

describe('discordChannel', () => {
  it('asks for the webhook address, which is secret because it has the token in it, and for the people to mention', () => {
    expect(discordChannel.fields.map(field => [field.key, field.kind, field.required])).toEqual([
      ['url', 'secret', true],
      ['mention', 'text', false],
    ]);
    expect(discordChannel.fields[0].hint).toContain('Copy Webhook URL');
  });

  it('posts the message as an embed in JSON to the webhook address', async () => {
    const service = fakeFetch(() => new Response(null, { status: 204 }));
    const context = service.context();

    const result = await discordChannel.send(settings, MESSAGE, context);

    expect(result).toEqual({ ok: true, detail: 'Discord answered 204' });
    expect(service.requests).toHaveLength(1);
    const [{ url, init }] = service.requests;
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(context.signal);
    expect(JSON.parse(String(init.body))).toEqual({
      embeds: [{ description: MESSAGE.text, color: AMBER, timestamp: MESSAGE.startedAt }],
      allowed_mentions: NO_MENTIONS,
    });
  });

  it('cuts the text to 4096 characters, the limit of the text of an embed', async () => {
    const body = await sendAndGetBody({ ...MESSAGE, text: 'x'.repeat(5000) });

    expect(body.embeds[0].description).toBe('x'.repeat(4096));
  });

  it('does not cut an emoji in two at the limit', async () => {
    const body = await sendAndGetBody({ ...MESSAGE, text: `${'x'.repeat(4095)}🔥 more` });

    expect(body.embeds[0].description).toBe('x'.repeat(4095));
  });

  describe('embed', () => {
    it.each([
      ['a critical alert', { severity: 'critical' as const }, 0xe74c3c],
      ['a warning', { severity: 'warning' as const }, AMBER],
      ['an alert that ended', { kind: 'ended' as const, severity: 'critical' as const }, 0x2ecc71],
      ['a test message', { kind: 'test' as const, severity: null }, 0x95a5a6],
      ['a message with no level', { severity: null }, 0x95a5a6],
      ['combined critical alerts', { kind: 'combined' as const, severity: 'critical' as const }, 0xe74c3c],
      ['"And 7 more alerts"', { kind: 'more' as const, severity: null }, 0x95a5a6],
    ])('has the color of %s', async (_name, change, color) => {
      const body = await sendAndGetBody({ ...MESSAGE, ...change });

      expect(body.embeds[0].color).toBe(color);
    });

    it('has the time that the alert started, and the time that it ended for an alert that ended', async () => {
      const ended = await sendAndGetBody({ ...MESSAGE, kind: 'ended', startedAt: '2026-11-13T15:40:00.000Z', endedAt: '2026-11-13T16:10:00.000Z' });

      expect(ended.embeds[0].timestamp).toBe('2026-11-13T16:10:00.000Z');
    });

    it('has no time when the message has none', async () => {
      const body = await sendAndGetBody({ ...MESSAGE, kind: 'test', severity: null, startedAt: null, endedAt: null });

      expect(body.embeds[0]).not.toHaveProperty('timestamp');
    });
  });

  describe('mentions', () => {
    const withMention = (mention: string) => ({ url: WEBHOOK, mention });

    async function bodyWith(mention: string, message: OutgoingMessage = MESSAGE) {
      const service = fakeFetch(() => new Response(null, { status: 204 }));
      await discordChannel.send(withMention(mention), message, service.context());
      return JSON.parse(String(service.requests[0].init.body));
    }

    it('sends no content and allows no mention when the box is empty', async () => {
      for (const body of [await sendAndGetBody(MESSAGE), await bodyWith(''), await bodyWith('   ')]) {
        expect(body).not.toHaveProperty('content');
        expect(body.allowed_mentions).toEqual(NO_MENTIONS);
      }
    });

    it('puts the mentions in the content, because an embed does not call anyone, and allows only those mentions', async () => {
      const body = await bodyWith('<@&111> <@222>  <@333>');

      expect(body.content).toBe('<@&111> <@222> <@333>');
      expect(body.allowed_mentions).toEqual({ parse: [], roles: ['111'], users: ['222', '333'] });
    });

    it.each(['@everyone', '@here', '@here <@&111>'])('allows everyone for %s', async mention => {
      const body = await bodyWith(mention);

      expect(body.content).toBe(mention);
      expect(body.allowed_mentions.parse).toEqual(['everyone']);
    });

    it('does not send the same id two times, because Discord refuses that', async () => {
      const body = await bodyWith('<@&111> <@&111> <@222> <@222>');

      expect(body.allowed_mentions).toEqual({ parse: [], roles: ['111'], users: ['222'] });
    });

    it.each(['started', 'combined', 'test'] as const)('calls the people for a %s message', async kind => {
      expect((await bodyWith('<@&111>', { ...MESSAGE, kind })).content).toBe('<@&111>');
    });

    it.each(['ended', 'more'] as const)('does not call the people for a %s message', async kind => {
      const body = await bodyWith('<@&111>', { ...MESSAGE, kind });

      expect(body).not.toHaveProperty('content');
      expect(body.allowed_mentions).toEqual(NO_MENTIONS);
    });

    it('does not let a name from the shop call anyone', async () => {
      const body = await bodyWith('<@&111>', { ...MESSAGE, text: 'WARNING - @everyone <@999>: Idle.' });

      expect(body.allowed_mentions).toEqual({ parse: [], roles: ['111'], users: [] });
    });

    it.each(['', '   ', '@everyone', '@here', '<@123>', '<@&123>', '<@&123>   <@456> @here'])('accepts the mention %j', mention => {
      expect(discordChannel.settings.safeParse({ url: WEBHOOK, mention }).success).toBe(true);
    });

    it.each(['@role', 'everyone', '@Everyone', '<@abc>', '<@&>', '<#123>', '123', '<@&123>,<@456>', '<@&123> and <@456>'])(
      'refuses the mention %j',
      mention => {
        expect(discordChannel.settings.safeParse({ url: WEBHOOK, mention }).error?.issues[0].message).toBe(BAD_MENTION);
      },
    );
  });

  it.each([408, 429, 500, 503])('tries again later when Discord answers %i (busy or a problem)', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: true, error: `Discord answered ${status}. Chatter tries again later.` });
  });

  it.each([401, 403, 404])('stops at once when Discord answers %i, and tells the admin to copy the address again', async status => {
    expect(await resultFor(status)).toEqual({
      ok: false,
      retry: false,
      error: `Discord answered ${status}. The webhook is deleted or the address is wrong. Copy the webhook address from Discord again.`,
    });
  });

  it.each([400, 413, 304])('stops at once when Discord refuses the message with %i', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: false, error: `Discord answered ${status} and refused the message.` });
  });

  it('stops at once when Discord sends Chatter to another address', async () => {
    const moved = fakeFetch(() => new Response(null, { status: 301, headers: { location: 'https://discord.com/new' } }));

    expect(await discordChannel.send(settings, MESSAGE, moved.context())).toEqual({
      ok: false,
      retry: false,
      error: 'Discord answered 301 and points to another address. Copy the webhook address from Discord again.',
    });
  });

  it('gives the result of the send, also when Chatter cannot close the answer', async () => {
    const response = new Response('ok', { status: 200 });
    response.body!.cancel = () => Promise.reject(new Error('the time limit ended'));

    expect(await discordChannel.send(settings, MESSAGE, fakeFetch(() => response).context()))
      .toEqual({ ok: true, detail: 'Discord answered 200' });
  });

  it('tries again later when Chatter cannot reach Discord', async () => {
    const refused = fakeFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });

    expect(await discordChannel.send(settings, MESSAGE, refused.context()))
      .toEqual({ ok: false, retry: true, error: 'Chatter could not reach Discord (ECONNREFUSED).' });
  });

  it('keeps the webhook address and its token out of each result text', async () => {
    const failed = fakeFetch(() => { throw new TypeError(`fetch failed for ${WEBHOOK}`, { cause: { code: 'ENOTFOUND' } }); });
    const results = [
      ...await Promise.all([200, 204, 301, 400, 401, 403, 404, 429, 500].map(resultFor)),
      await discordChannel.send(settings, MESSAGE, failed.context()),
    ];

    for (const result of results) {
      expect(textOf(result)).not.toContain(TOKEN);
      expect(textOf(result)).not.toContain('/api/webhooks/');
    }
  });

  describe('settings', () => {
    it.each([
      WEBHOOK,
      `https://discordapp.com/api/webhooks/1/${TOKEN}`,
      `https://ptb.discord.com/api/webhooks/1/${TOKEN}`,
      `https://canary.discord.com/api/webhooks/1/${TOKEN}/`,
      `  ${WEBHOOK}  `,
    ])('accepts the Discord webhook address %s', url => {
      expect(discordChannel.settings.safeParse({ url }).success).toBe(true);
    });

    it.each([
      undefined,
      '',
      'discord.com/api/webhooks/1/abc',
      'http://discord.com/api/webhooks/1/abc',
      'https://evil.example.com/api/webhooks/1/abc',
      'https://discord.com.example.com/api/webhooks/1/abc',
      'https://other.discord.com/api/webhooks/1/abc',
      'https://discord.com:8443/api/webhooks/1/abc',
      'https://user:pass@discord.com/api/webhooks/1/abc',
      'https://discord.com/channels/1/2',
      'https://discord.com/api/webhooks/1',
      'https://discord.com/api/webhooks/abc/def',
      'https://discord.com/api/webhooks/1/abc/slack',
    ])('refuses %s, which is not a Discord webhook address', url => {
      expect(firstProblem({ url })).toBe(BAD_URL);
    });

    it('does not put the address in the problem text', () => {
      expect(firstProblem({ url: `https://evil.example.com/api/webhooks/1/${TOKEN}` })).not.toContain(TOKEN);
    });
  });
});
