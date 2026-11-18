import { describe, expect, it } from 'vitest';
import type { OutgoingMessage, SendContext, SendResult } from './ChannelType.js';
import { telegramChannel } from './telegram.js';

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

const TOKEN = '123456789:AAH-token_for_tests';
const settings = { token: TOKEN, chatId: '-1001234567890' };

async function resultFor(status: number) {
  return telegramChannel.send(settings, MESSAGE, fakeFetch(() => new Response(null, { status })).context());
}

function firstProblem(values: unknown): string | undefined {
  return telegramChannel.settings.safeParse(values).error?.issues[0].message;
}

function textOf(result: SendResult): string {
  return result.ok ? result.detail : result.error;
}

describe('telegramChannel', () => {
  it('asks for a bot token that stays secret and a chat ID', () => {
    expect(telegramChannel.fields.map(field => [field.key, field.label, field.kind, field.required, field.mono])).toEqual([
      ['token', 'Bot token', 'secret', true, true],
      ['chatId', 'Chat ID', 'text', true, true],
    ]);
    expect(telegramChannel.fields[0].hint).toContain('@BotFather');
    expect(telegramChannel.fields[1].hint).toContain('-1001234567890');
  });

  it('tells the admin before they start that the bot cannot write first', () => {
    expect(telegramChannel.note).toContain('bot');
    expect(telegramChannel.note).toContain('group');
  });

  it('sends the text line to the chat with the Bot API', async () => {
    const service = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    const context = service.context();

    const result = await telegramChannel.send(settings, MESSAGE, context);

    expect(result).toEqual({ ok: true, detail: 'Telegram sent it' });
    expect(service.requests).toHaveLength(1);
    const [{ url, init }] = service.requests;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(context.signal);
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '-1001234567890', text: MESSAGE.text });
  });

  it('cuts the text to 4096 characters, the limit of Telegram', async () => {
    const service = fakeFetch(() => new Response(null, { status: 200 }));

    await telegramChannel.send(settings, { ...MESSAGE, text: 'x'.repeat(5000) }, service.context());

    expect(JSON.parse(String(service.requests[0].init.body)).text).toBe('x'.repeat(4096));
  });

  it('does not cut an emoji in two at the limit', async () => {
    const service = fakeFetch(() => new Response(null, { status: 200 }));

    await telegramChannel.send(settings, { ...MESSAGE, text: `${'x'.repeat(4095)}🔥` }, service.context());

    expect(JSON.parse(String(service.requests[0].init.body)).text).toBe('x'.repeat(4095));
  });

  it.each([401, 404])('stops at once when Telegram answers %i, because the bot token is wrong', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: false, error: 'Telegram refused the bot token. Check the bot token.' });
  });

  it('stops at once when Telegram answers 400, because the chat ID is wrong', async () => {
    expect(await resultFor(400)).toEqual({ ok: false, retry: false, error: 'Telegram cannot find the chat. Check the chat ID.' });
  });

  it('stops at once when Telegram answers 403, and tells how to let the bot write to the chat', async () => {
    expect(await resultFor(403)).toEqual({
      ok: false,
      retry: false,
      error: 'The bot cannot write to the chat. Send a message to the bot, or add the bot to the group or channel.',
    });
  });

  it.each([408, 429, 500, 502])('tries again later when Telegram answers %i (busy or a problem)', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: true, error: `Telegram answered ${status}. Chatter tries again later.` });
  });

  it.each([302, 409])('stops at once when Telegram answers %i', async status => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: false, error: `Telegram answered ${status}.` });
  });

  it('gives the result of the send, also when Chatter cannot close the answer', async () => {
    const response = new Response('ok', { status: 200 });
    response.body!.cancel = () => Promise.reject(new Error('the time limit ended'));

    expect(await telegramChannel.send(settings, MESSAGE, fakeFetch(() => response).context()))
      .toEqual({ ok: true, detail: 'Telegram sent it' });
  });

  it('tries again later when Chatter cannot reach Telegram', async () => {
    const refused = fakeFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });

    expect(await telegramChannel.send(settings, MESSAGE, refused.context()))
      .toEqual({ ok: false, retry: true, error: 'Chatter could not reach Telegram (ECONNREFUSED).' });
  });

  it('keeps the bot token and the address out of the error, also when the network error text has them', async () => {
    const failed = fakeFetch(() => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`, { cause: { code: 'ENOTFOUND' } });
    });

    const result = await telegramChannel.send(settings, MESSAGE, failed.context());

    expect(result).toEqual({ ok: false, retry: true, error: 'Chatter could not reach Telegram (ENOTFOUND).' });
  });

  it.each([200, 302, 400, 401, 403, 404, 409, 429, 500])('keeps the bot token and the address out of the text for answer %i', async status => {
    const text = textOf(await resultFor(status));

    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('AAH-token_for_tests');
    expect(text).not.toContain('api.telegram.org');
  });

  describe('settings', () => {
    it('accepts a group ID, a person ID, and a public channel name', () => {
      for (const chatId of ['-1001234567890', '123456789', '@shop_floor']) {
        expect(telegramChannel.settings.safeParse({ token: TOKEN, chatId }).success).toBe(true);
      }
    });

    it('removes the spaces around the token and the chat ID', () => {
      expect(telegramChannel.settings.parse({ token: ` ${TOKEN} `, chatId: ' @shop ' })).toEqual({ token: TOKEN, chatId: '@shop' });
    });

    it.each([undefined, '', 'AAH-token', '123456789', 'abc:AAH', '123:AA H', '123:AA/H'])(
      'refuses the bot token %s, and does not show it in the message',
      token => {
        const problem = firstProblem({ token, chatId: settings.chatId });
        expect(problem).toBe('Bot token must be the token from @BotFather: digits, a colon (:), and then letters and digits');
        if (token) expect(problem).not.toContain(token);
      },
    );

    it.each([undefined, '', 'shop', '@', '@shop floor', '12-34', '-', 'https://t.me/shop'])(
      'refuses the chat ID %s',
      chatId => {
        expect(firstProblem({ token: TOKEN, chatId }))
          .toBe('Chat ID must be a number, for example -1001234567890, or @ and the channel name');
      },
    );
  });
});
