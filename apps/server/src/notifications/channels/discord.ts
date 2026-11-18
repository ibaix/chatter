import { z } from 'zod';
import type { ChannelDefinition, OutgoingMessage, SendResult } from './ChannelType.js';
import { networkFailure } from './networkFailure.js';
import { REDIRECTS } from './webAddress.js';

const BAD_URL = 'Webhook address must start with https://discord.com/api/webhooks/';
const COPY_AGAIN = 'Copy the webhook address from Discord again.';

const BAD_MENTION = 'Mention can have only @everyone, @here, <@USER_ID>, and <@&ROLE_ID>, with a space between them';

/** Discord refuses an embed with a longer text */
const MAX_DESCRIPTION = 4096;
/** The side color of the embed */
const RED = 0xe74c3c;
const AMBER = 0xf1c40f;
const GREEN = 0x2ecc71;
const GRAY = 0x95a5a6;
/** Only a new alert, and a test, call the people. An alert that ended, and "And 7 more alerts", do not. */
const MENTION_KINDS = new Set<OutgoingMessage['kind']>(['started', 'combined', 'test']);
/** One mention: a person, a role, or everyone */
const MENTION = /^(?:<@&?\d+>|@everyone|@here)$/;
const HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com', 'ptb.discordapp.com', 'canary.discordapp.com']);
/** The id and the token of the webhook. A word after the token, for example /slack, changes the body that Discord expects. */
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[\w-]+\/?$/;

const discordSettings = z.object({
  url: z.string({ error: BAD_URL }).trim().refine(isDiscordWebhook, BAD_URL),
  mention: z.string().trim().refine(text => mentionsOf(text).every(word => MENTION.test(word)), BAD_MENTION).optional(),
});

type DiscordSettings = z.infer<typeof discordSettings>;

/**
 * Sends each message as an embed to a channel of a Discord server, through a webhook of that channel.
 * An embed does not call anyone, so the mentions go in the content, next to the embed.
 */
export const discordChannel: ChannelDefinition<DiscordSettings> = {
  id: 'discord',
  name: 'Discord',
  fields: [
    {
      key: 'url', label: 'Webhook address', kind: 'secret', required: true, mono: true,
      hint: 'In Discord, open Server Settings > Integrations > Webhooks. Select a webhook and click Copy Webhook URL. Paste it here.',
    },
    {
      key: 'mention', label: 'Mention (optional)', kind: 'text', required: false, mono: true,
      hint: 'Calls these people when an alert starts. Use <@USER_ID> for a person, <@&ROLE_ID> for a role, or @here or @everyone.',
    },
  ],
  settings: discordSettings,
  async send(settings, message, { fetch, signal }) {
    const body = JSON.stringify(discordBody(message, MENTION_KINDS.has(message.kind) ? mentionsOf(settings.mention) : []));
    try {
      // A redirect would change the POST to a GET, so Chatter does not follow it
      const response = await fetch(settings.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'manual', signal,
      });
      // Chatter does not read the answer. A failure to close it must not send the message again.
      response.body?.cancel().catch(() => {});
      return resultOf(response.status);
    } catch (error) {
      return networkFailure(error, 'Discord');
    }
  },
};

function discordBody(message: OutgoingMessage, mentions: string[]) {
  const timestamp = (message.kind === 'ended' ? message.endedAt : message.startedAt) ?? undefined;
  return {
    content: mentions.length > 0 ? mentions.join(' ') : undefined,
    embeds: [{ description: cut(message.text), color: colorOf(message), timestamp }],
    // Only the mentions of the form can call people. A name from the shop, such as "@everyone", cannot.
    allowed_mentions: allowedMentions(mentions),
  };
}

function colorOf(message: OutgoingMessage): number {
  if (message.kind === 'ended') return GREEN;
  if (message.severity === 'critical') return RED;
  return message.severity === 'warning' ? AMBER : GRAY;
}

function mentionsOf(text: string | undefined): string[] {
  return [...new Set((text ?? '').split(/\s+/).filter(Boolean))];
}

/** Discord refuses the same id two times, and mentionsOf has already removed the same words */
function allowedMentions(mentions: string[]) {
  const idsOf = (isKind: (mention: string) => boolean) => [...new Set(mentions.filter(isKind).map(mention => mention.replace(/\D/g, '')))];
  return {
    parse: mentions.some(mention => mention.startsWith('@')) ? ['everyone'] : [],
    roles: idsOf(mention => mention.startsWith('<@&')),
    users: idsOf(mention => mention.startsWith('<@') && !mention.startsWith('<@&')),
  };
}

function isDiscordWebhook(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const { protocol, hostname, port, username, password, pathname } = new URL(text);
  return protocol === 'https:' && HOSTS.has(hostname) && !port && !username && !password && WEBHOOK_PATH.test(pathname);
}

/** Cuts the text to the limit, and does not cut an emoji in two */
function cut(text: string): string {
  const short = text.slice(0, MAX_DESCRIPTION);
  return /[\uD800-\uDBFF]$/.test(short) ? short.slice(0, -1) : short;
}

function resultOf(status: number): SendResult {
  const answered = `Discord answered ${status}`;
  if (status >= 200 && status < 300) return { ok: true, detail: answered };
  if (REDIRECTS.has(status)) return { ok: false, retry: false, error: `${answered} and points to another address. ${COPY_AGAIN}` };
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, retry: true, error: `${answered}. Chatter tries again later.` };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { ok: false, retry: false, error: `${answered}. The webhook is deleted or the address is wrong. ${COPY_AGAIN}` };
  }
  return { ok: false, retry: false, error: `${answered} and refused the message.` };
}
