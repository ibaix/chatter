import { describe, expect, it } from 'vitest';
import { defineChannelType } from './ChannelType.js';
import { telegramChannel } from './telegram.js';
import { BUSY, fakeFetch, textOf, WARNING_MESSAGE as MESSAGE, TOO_MANY } from './testSupport.js';

const TOKEN = '123456789:AAH-token_for_tests';
const settings = { token: TOKEN, chatId: '-1001234567890', sound: 'normal' as const };

async function resultFor(status: number) {
  return telegramChannel.send(settings, MESSAGE, fakeFetch(() => new Response(null, { status })).context());
}

async function resultForJson(status: number, answer: unknown) {
  const json = () => new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  return telegramChannel.send(settings, MESSAGE, fakeFetch(json).context());
}

function firstProblem(values: unknown): string | undefined {
  return telegramChannel.settings.safeParse(values).error?.issues[0].message;
}

describe('telegramChannel', () => {
  it('asks for a bot token that stays secret and a chat ID', () => {
    expect(telegramChannel.fields.map(field => [field.key, field.label, field.kind, field.required, field.mono])).toEqual([
      ['token', 'Bot token', 'secret', true, true],
      ['chatId', 'Chat ID', 'text', true, true],
      ['sound', 'Notification sound', 'choice', false, undefined],
    ]);
    expect(telegramChannel.fields[0].hint).toContain('@BotFather');
    expect(telegramChannel.fields[1].hint).toContain('-1001234567890');
  });

  it('asks for the notification sound, Normal at first', () => {
    const sound = telegramChannel.fields.find(field => field.key === 'sound');

    expect(sound?.options).toEqual([{ value: 'normal', label: 'Normal' }, { value: 'quiet', label: 'Quiet' }]);
    expect(sound?.default).toBe('normal');
    expect(sound?.hint).toContain('Quiet');
  });

  describe('notification sound', () => {
    async function bodyOf(values: unknown, kind: 'started' | 'ended' | 'combined' | 'more' | 'test') {
      const service = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
      await defineChannelType(telegramChannel).send(values, { ...MESSAGE, kind }, service.context());
      return JSON.parse(String(service.requests[0].init.body));
    }

    const KINDS = ['started', 'ended', 'combined', 'more', 'test'] as const;

    it('sends each message of a Quiet channel with no sound, whatever its kind', async () => {
      for (const kind of KINDS) expect((await bodyOf({ ...settings, sound: 'quiet' }, kind)).disable_notification).toBe(true);
    });

    it('sends each message of a Normal channel with the sound', async () => {
      for (const kind of KINDS) expect(await bodyOf(settings, kind)).not.toHaveProperty('disable_notification');
    });

    it('sends with the sound for a channel saved before the sound was there', async () => {
      expect(await bodyOf({ token: TOKEN, chatId: '-1001234567890' }, 'started')).not.toHaveProperty('disable_notification');
    });
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

  it('stops at once when Telegram answers 400 with no reason, and does not guess the reason', async () => {
    expect(await resultFor(400)).toEqual({ ok: false, retry: false, error: 'Telegram answered 400.' });
  });

  it('does not guess the reason when a proxy answers 400 with a web page', async () => {
    const page = fakeFetch(() => new Response('<html>Bad Request</html>', { status: 400, headers: { 'content-type': 'text/html' } }));

    expect(await telegramChannel.send(settings, MESSAGE, page.context())).toEqual({ ok: false, retry: false, error: 'Telegram answered 400.' });
  });

  it('tells that the chat ID is wrong when Telegram cannot find the chat', async () => {
    expect(await resultForJson(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }))
      .toEqual({ ok: false, retry: false, error: 'Telegram cannot find the chat. Check the chat ID.' });
  });

  it('gives the new chat ID when a group became a supergroup', async () => {
    const answer = {
      ok: false, error_code: 400,
      description: 'Bad Request: group chat was upgraded to a supergroup chat',
      parameters: { migrate_to_chat_id: -1009876543210 },
    };

    expect(await resultForJson(400, answer)).toEqual({
      ok: false, retry: false,
      error: 'The group is now a supergroup, and it has a new chat ID. Change the chat ID to -1009876543210.',
    });
  });

  it('cuts a long reason of Telegram, and removes its period', async () => {
    expect(await resultForJson(400, { ok: false, description: `Bad Request: ${'x'.repeat(300)}.` }))
      .toEqual({ ok: false, retry: false, error: `Telegram refused the message: ${`Bad Request: ${'x'.repeat(300)}`.slice(0, 200)}.` });
    expect(await resultForJson(400, { ok: false, description: 'Bad Request: message text is empty.' }))
      .toEqual({ ok: false, retry: false, error: 'Telegram refused the message: Bad Request: message text is empty.' });
  });

  it('gives the reason when the new chat ID of a supergroup is not a number', async () => {
    const answer = { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: 'x' } };

    expect(await resultForJson(400, answer)).toEqual({
      ok: false, retry: false, error: 'Telegram refused the message: Bad Request: group chat was upgraded to a supergroup chat.',
    });
  });

  it('gives the reason of Telegram for another 400', async () => {
    expect(await resultForJson(400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' }))
      .toEqual({ ok: false, retry: false, error: 'Telegram refused the message: Bad Request: message text is empty.' });
  });

  it('keeps the bot token out of the reason of Telegram', async () => {
    const text = textOf(await resultForJson(400, { ok: false, description: `Bad Request: bad bot ${TOKEN}` }));

    expect(text).not.toContain(TOKEN);
  });

  it('stops at once when Telegram answers 403, and tells how to let the bot write to the chat', async () => {
    expect(await resultFor(403)).toEqual({
      ok: false,
      retry: false,
      error: 'The bot cannot write to the chat. Send a message to the bot, or add the bot to the group or channel.',
    });
  });

  it.each([[408, BUSY], [429, TOO_MANY], [500, BUSY], [502, BUSY]])('tries again later when Telegram answers %i (busy or a problem)', async (status, ending) => {
    expect(await resultFor(status)).toEqual({ ok: false, retry: true, error: `Telegram answered ${status}${ending}` });
  });

  it('stops at once when Telegram answers 409', async () => {
    expect(await resultFor(409)).toEqual({ ok: false, retry: false, error: 'Telegram answered 409.' });
  });

  it('stops at once when Telegram answers with a redirect', async () => {
    expect(await resultFor(302))
      .toEqual({ ok: false, retry: false, error: 'Telegram answered 302 and points to another address. A proxy of the shop network can cause this.' });
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
      expect(telegramChannel.settings.parse({ token: ` ${TOKEN} `, chatId: ' @shop ' })).toEqual({ token: TOKEN, chatId: '@shop', sound: 'normal' });
    });

    it('refuses a sound that Chatter does not have for Telegram', () => {
      expect(firstProblem({ ...settings, sound: 'urgent' })).toBe('Notification sound must be Normal or Quiet');
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
