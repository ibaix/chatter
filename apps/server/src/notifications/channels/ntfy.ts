import { z } from 'zod';
import type { ChannelDefinition, OutgoingMessage, SendResult } from './ChannelType.js';
import { type Answer, cutText, postJson, statusResult } from './http.js';
import { hasNoLogin, isHttpAddress } from './webAddress.js';

const PUBLIC_HOST = 'ntfy.sh';
const PUBLIC_SERVER = `https://${PUBLIC_HOST}`;

const BAD_TOPIC = 'Topic can have only letters, digits, - and _, up to 64 characters';
const BAD_URL = 'Server must start with http:// or https://';
const LOGIN_IN_URL = 'Remove the user name and password from the server address. Put an access token in Access token.';
const TOPIC_IN_URL = 'Remove the topic from the server address. Put only the topic in Topic.';
const BAD_TOKEN = 'Access token can have only plain letters, digits, and signs, with no spaces';

/** The topic names that ntfy accepts */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
/** fetch refuses a header value with other characters */
const HEADER_SAFE = /^[\x21-\x7e]*$/;
/** ntfy tells the reason in English. A long reason is cut. */
const MAX_REASON = 200;

const ntfySettings = z.object({
  topic: z.string({ error: BAD_TOPIC }).trim().regex(TOPIC, BAD_TOPIC),
  url: z.string().trim()
    .refine(text => text === '' || isHttpAddress(text), BAD_URL)
    .refine(hasNoLogin, LOGIN_IN_URL)
    .optional(),
  token: z.string().trim().regex(HEADER_SAFE, BAD_TOKEN).optional(),
}).refine(({ topic, url }) => !url || !hasTopicPath(url, topic), { message: TOPIC_IN_URL, path: ['url'] });

type NtfySettings = z.infer<typeof ntfySettings>;

/**
 * Sends each message as a push message to a topic of ntfy, on ntfy.sh or on a server of the shop.
 * Chatter sends JSON, not headers, because a header cannot have a machine name with accents.
 * On ntfy.sh, each person that knows the topic can read it, so the topic is a secret field.
 */
export const ntfyChannel: ChannelDefinition<NtfySettings> = {
  id: 'ntfy',
  name: 'ntfy',
  fields: [
    {
      key: 'topic', label: 'Topic', kind: 'secret', required: true, mono: true,
      hint: 'Use a name that other people cannot guess, for example chatter-x7k2p9. On ntfy.sh, each person that knows the name can read the alerts.',
    },
    {
      key: 'url', label: 'Server (optional)', kind: 'url', required: false, mono: true,
      hint: `Only for a server of the shop, without the topic. Empty sends to ${PUBLIC_SERVER}.`,
    },
    {
      key: 'token', label: 'Access token (optional)', kind: 'secret', required: false, mono: true,
      hint: 'Only when the topic needs a login. Make a token in ntfy under Account > Access tokens.',
    },
  ],
  note: 'Install the ntfy app on each phone, and subscribe to the topic in the ntfy app before you send a test.',
  settings: ntfySettings,
  send(settings, message, context) {
    const request = {
      url: serverOf(settings.url),
      headers: settings.token ? { authorization: `Bearer ${settings.token}` } : undefined,
      body: ntfyBody(settings.topic, message),
      readJson: true,
    };
    return postJson(context, 'the ntfy server', request, answer => resultOf(answer, settings));
  },
};

/** The JSON publish of ntfy: https://docs.ntfy.sh/publish/#publish-as-json */
function ntfyBody(topic: string, message: OutgoingMessage) {
  return {
    topic,
    title: message.machine ? `Chatter: ${message.machine.name}` : 'Chatter',
    message: message.text,
    priority: priorityOf(message),
    tags: [tagOf(message)],
    ...(message.link ? { click: message.link } : {}),
  };
}

/** ntfy priorities: 5 is urgent (a long vibration), 4 is high, 3 is the default */
function priorityOf({ kind, severity }: OutgoingMessage): number {
  if (kind === 'ended' || kind === 'test') return 3;
  return severity === 'critical' ? 5 : 4;
}

/** ntfy shows these tags as emoji in front of the title */
function tagOf({ kind, severity }: OutgoingMessage): string {
  if (kind === 'ended') return 'white_check_mark';
  if (kind === 'test') return 'bell';
  return severity === 'critical' ? 'rotating_light' : 'warning';
}

/** The address of the server as the admin typed it. A proxy under /ntfy/ answers a redirect for /ntfy, so Chatter does not remove a slash. */
function serverOf(url: string | undefined): string {
  return new URL(url || PUBLIC_SERVER).href;
}

/**
 * A pasted topic address, for example https://ntfy.sh/my-topic, would send the JSON as the text of the message.
 * ntfy.sh takes the JSON only at its root, so each path there is a topic. A server of the shop can be under a path,
 * so there only a path that ends with the topic is refused. A server under /alerts with the topic "alerts" is refused too.
 */
function hasTopicPath(url: string, topic: string): boolean {
  if (!URL.canParse(url)) return false;
  const { hostname, pathname } = new URL(url);
  if (hostname === PUBLIC_HOST) return pathname !== '/';
  return pathname.replace(/\/$/, '').endsWith(`/${topic}`);
}

/** The error answer of ntfy, for example {"code":40009,"http":400,"error":"invalid request"} */
interface NtfyError {
  error?: unknown;
}

function resultOf({ status, json }: Answer, settings: NtfySettings): SendResult {
  return statusResult(status, {
    answered: `ntfy answered ${status}`,
    sent: 'ntfy sent it',
    refused: () => refusalOf(status, json, settings),
  });
}

function refusalOf(status: number, json: unknown, { topic, token }: NtfySettings): string {
  if (status === 401 || status === 403) return 'ntfy refused the access. Check the access token, and that it can write to the topic.';
  if (status === 413) return 'ntfy refused the message because it is too long.';
  const reason = typeof json === 'object' && json !== null ? (json as NtfyError).error : undefined;
  if (status === 400 && typeof reason === 'string' && reason) {
    let safe = reason.replaceAll(topic, '(topic)');
    if (token) safe = safe.replaceAll(token, '(access token)');
    return `ntfy refused the message: ${cutText(safe, MAX_REASON).replace(/\.$/, '')}.`;
  }
  return `ntfy answered ${status}. Check the server address.`;
}
