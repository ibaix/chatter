import { z } from 'zod';
import type { ChannelDefinition, SendResult } from './ChannelType.js';
import {
  type Answer, cutText, type JsonObject, postJson, serviceReason, statusResult, waitOfSeconds, withWait,
} from './http.js';
import { soundField, soundSetting } from './sound.js';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram refuses a longer text */
const MAX_TEXT = 4096;

const BAD_TOKEN = 'Bot token must be the token from @BotFather: digits, a colon (:), and then letters and digits';
const BAD_CHAT_ID = 'Chat ID must be a number, for example -1001234567890, or @ and the channel name';

const telegramSettings = z.object({
  token: z.string({ error: BAD_TOKEN }).trim().regex(/^\d+:[A-Za-z0-9_-]+$/, BAD_TOKEN),
  chatId: z.string({ error: BAD_CHAT_ID }).trim().regex(/^(-?\d+|@\w+)$/, BAD_CHAT_ID),
  sound: soundSetting(['normal', 'quiet']),
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
    soundField(['normal', 'quiet'], 'For each message of this channel. Quiet shows the message with no sound.'),
  ],
  note: 'Telegram does not let a bot write first. Send a message to the bot, or add the bot to the group or channel, before you send a test.',
  settings: telegramSettings,
  send(settings, message, context) {
    const request = {
      url: `${TELEGRAM_API}/bot${settings.token}/sendMessage`,
      body: {
        chat_id: settings.chatId,
        text: cutText(message.text, MAX_TEXT),
        // Telegram shows the message with no sound
        ...(settings.sound === 'quiet' ? { disable_notification: true } : {}),
      },
      readJson: true,
    };
    return postJson(context, 'Telegram', request, answer => resultOf(answer, settings.token));
  },
};

/** The error answer of the Bot API: https://core.telegram.org/bots/api#making-requests */
interface TelegramError extends JsonObject {
  description?: unknown;
  parameters?: { migrate_to_chat_id?: unknown; retry_after?: unknown };
}

function resultOf({ status, json, retryAfterMs }: Answer, token: string): SendResult {
  const answer: TelegramError = json ?? {};
  const result = statusResult(status, {
    answered: `Telegram answered ${status}`,
    sent: 'Telegram sent it',
    moved: 'A proxy of the shop network can cause this.',
    refused: () => refusalOf(status, answer, token),
  });
  return withWait(result, longerWait(retryAfterMs, waitOfSeconds(answer.parameters?.retry_after)));
}

/**
 * Telegram gives the wait of a 429 in the answer, in `parameters.retry_after`. A proxy can give a Retry-After header.
 * When both give a wait, Chatter uses the longer one, so it does not send before the service is ready.
 */
function longerWait(header: number | undefined, body: number | undefined): number | undefined {
  if (header === undefined) return body;
  return body === undefined ? header : Math.max(header, body);
}

function refusalOf(status: number, answer: TelegramError, token: string): string {
  if (status === 401 || status === 404) return 'Telegram refused the bot token. Check the bot token.';
  if (status === 403) return 'The bot cannot write to the chat. Send a message to the bot, or add the bot to the group or channel.';
  if (status !== 400) return `Telegram answered ${status}.`;
  const newChatId = answer.parameters?.migrate_to_chat_id;
  if (typeof newChatId === 'number') {
    return `The group is now a supergroup, and it has a new chat ID. Change the chat ID to ${newChatId}.`;
  }
  const reason = typeof answer.description === 'string' ? answer.description : '';
  // A 400 with no reason can be from a proxy, so Chatter does not guess the reason
  if (!reason) return `Telegram answered ${status}.`;
  if (/chat not found/i.test(reason)) return 'Telegram cannot find the chat. Check the chat ID.';
  return `Telegram refused the message: ${serviceReason(reason, [[token, '(bot token)']])}.`;
}
