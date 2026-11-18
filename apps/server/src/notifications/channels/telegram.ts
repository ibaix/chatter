import { z } from 'zod';
import type { ChannelDefinition, SendResult } from './ChannelType.js';
import { networkFailure } from './networkFailure.js';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram refuses a longer text */
const MAX_TEXT = 4096;

const BAD_TOKEN = 'Bot token must be the token from @BotFather: digits, a colon (:), and then letters and digits';
const BAD_CHAT_ID = 'Chat ID must be a number, for example -1001234567890, or @ and the channel name';

const telegramSettings = z.object({
  token: z.string({ error: BAD_TOKEN }).trim().regex(/^\d+:[A-Za-z0-9_-]+$/, BAD_TOKEN),
  chatId: z.string({ error: BAD_CHAT_ID }).trim().regex(/^(-?\d+|@\w+)$/, BAD_CHAT_ID),
});

type TelegramSettings = z.infer<typeof telegramSettings>;

/**
 * Sends each message as a text line to a Telegram chat, with a bot of the shop.
 * The token is in the request address, so no error text has the address in it.
 */
export const telegramChannel: ChannelDefinition<TelegramSettings> = {
  id: 'telegram',
  name: 'Telegram',
  fields: [
    {
      key: 'token', label: 'Bot token', kind: 'secret', required: true, mono: true,
      hint: 'In Telegram, send /newbot to @BotFather. Then copy the token here.',
    },
    {
      key: 'chatId', label: 'Chat ID', kind: 'text', required: true, mono: true,
      hint: 'A number, for example -1001234567890 for a group. Or @ and the name of a public channel.',
    },
  ],
  note: 'Telegram does not let a bot write first. Send a message to the bot, or add the bot to the group or channel, before you send a test.',
  settings: telegramSettings,
  async send(settings, message, { fetch, signal }) {
    try {
      // A redirect would change the POST to a GET, so Chatter does not follow it
      const response = await fetch(`${TELEGRAM_API}/bot${settings.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.chatId, text: cut(message.text) }),
        redirect: 'manual',
        signal,
      });
      // Chatter does not read the answer. A failure to close it must not send the message again.
      response.body?.cancel().catch(() => {});
      return resultOf(response.status);
    } catch (error) {
      return networkFailure(error, 'Telegram');
    }
  },
};

/** Cuts the text to the limit, but not in the middle of an emoji */
function cut(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, '') : text;
}

function resultOf(status: number): SendResult {
  if (status >= 200 && status < 300) return { ok: true, detail: 'Telegram sent it' };
  if (status === 401 || status === 404) {
    return { ok: false, retry: false, error: 'Telegram refused the bot token. Check the bot token.' };
  }
  if (status === 400) return { ok: false, retry: false, error: 'Telegram cannot find the chat. Check the chat ID.' };
  if (status === 403) {
    return {
      ok: false, retry: false,
      error: 'The bot cannot write to the chat. Send a message to the bot, or add the bot to the group or channel.',
    };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, retry: true, error: `Telegram answered ${status}. Chatter tries again later.` };
  }
  return { ok: false, retry: false, error: `Telegram answered ${status}.` };
}
