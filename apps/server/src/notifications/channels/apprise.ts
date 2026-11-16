import { z } from 'zod';
import type { ChannelDefinition, OutgoingMessage, SendResult } from './ChannelType.js';
import { networkFailure } from './networkFailure.js';
import { hasNoLogin, isHttpAddress } from './webAddress.js';

/** Apprise answers only after it sent the message to each service, and an email server can be slow */
const APPRISE_TIMEOUT_MS = 60_000;

const BAD_URL = 'Apprise address must start with http:// or https://';
const NO_KEY = 'Apprise address must end with /notify/ and your config key, for example http://apprise.local:8000/notify/chatter';
const LOGIN_IN_URL = 'Remove the user name and password from the address. Put them in User name and Password.';
const BAD_TAG = 'Tag can have only letters, digits, -, _, commas, and spaces';
const COLON_IN_USERNAME = 'User name cannot have a colon (:)';

/** The config key of Apprise API has 1 to 128 letters, digits, - or _ */
const NOTIFY_PATH = /^\/notify\/[\w-]{1,128}\/?$/;
/** In Apprise, a comma means "or" and a space means "and" */
const TAG = /^[\w\-, ]*$/;

/** The answers that point to another address in the Location header */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The kinds of message of Apprise. Each service shows them in its own way, for example with a color or an icon. */
type AppriseType = 'info' | 'success' | 'warning' | 'failure';

const appriseSettings = z.object({
  url: z.string({ error: BAD_URL }).trim()
    .refine(isHttpAddress, BAD_URL)
    .refine(hasNotifyPath, NO_KEY)
    .refine(hasNoLogin, LOGIN_IN_URL),
  tag: z.string().trim().regex(TAG, BAD_TAG).optional(),
  username: z.string().trim().refine(text => !text.includes(':'), COLON_IN_USERNAME).optional(),
  password: z.string().optional(),
});

type AppriseSettings = z.infer<typeof appriseSettings>;

/**
 * Sends each message to an Apprise API server of the shop, with a saved config key.
 * Apprise then sends it to each service of that config, for example Teams, Discord, Telegram, or email.
 * The tokens of these services stay in Apprise, not in chatter.db.
 */
export const appriseChannel: ChannelDefinition<AppriseSettings> = {
  id: 'apprise',
  name: 'Apprise',
  fields: [
    {
      key: 'url', label: 'Apprise address', kind: 'url', required: true, mono: true,
      hint: 'The address of Apprise API with your config key, for example http://apprise.local:8000/notify/chatter',
    },
    {
      key: 'tag', label: 'Tag (optional)', kind: 'text', required: false, mono: true,
      hint: 'Sends only to the services with this tag. Empty sends to the services with no tag. "all" sends to each service.',
    },
    { key: 'username', label: 'User name (optional)', kind: 'text', required: false, hint: 'Only when Apprise asks for a login.' },
    { key: 'password', label: 'Password (optional)', kind: 'secret', required: false, hint: 'Only when Apprise asks for a login.' },
  ],
  note: 'Apprise API runs on another computer with a 64-bit processor. It does not run on the Chatter Raspberry Pi card. '
    + 'First save the addresses of your services in Apprise under a config key, for example "chatter".',
  timeoutMs: APPRISE_TIMEOUT_MS,
  settings: appriseSettings,
  async send(settings, message, { fetch, signal }) {
    try {
      // A redirect would change the POST to a GET, so Chatter does not follow it
      const response = await fetch(settings.url, {
        method: 'POST', headers: headersOf(settings), body: JSON.stringify(appriseBody(message, settings.tag)), redirect: 'manual', signal,
      });
      // Chatter does not read the answer. A failure to close it must not send the message again.
      response.body?.cancel().catch(() => {});
      return resultOf(response.status);
    } catch (error) {
      return networkFailure(error, 'Apprise');
    }
  },
};

function hasNotifyPath(text: string): boolean {
  return URL.canParse(text) && NOTIFY_PATH.test(new URL(text).pathname);
}

function headersOf({ username, password }: AppriseSettings): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (username || password) {
    headers.authorization = `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`, 'utf8').toString('base64')}`;
  }
  return headers;
}

function appriseBody(message: OutgoingMessage, tag: string | undefined) {
  return {
    title: message.machine ? `Chatter: ${message.machine.name}` : 'Chatter',
    body: message.text,
    type: appriseTypeOf(message),
    format: 'text',
    ...(tag ? { tag } : {}),
  };
}

function appriseTypeOf({ kind, severity }: OutgoingMessage): AppriseType {
  switch (kind) {
    case 'test':
      return 'info';
    case 'ended':
      return 'success';
    case 'more':
      return 'warning';
    case 'started':
    case 'combined':
      return severity === 'critical' ? 'failure' : 'warning';
  }
}

function resultOf(status: number): SendResult {
  const answered = `Apprise answered ${status}`;
  if (status >= 200 && status < 300) return { ok: true, detail: 'Apprise sent it' };
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, retry: true, error: `${answered}. Chatter tries again later.` };
  }
  return { ok: false, retry: false, error: refusalOf(status) };
}

/** Each refusal stops at once. 424 can mean that some services got the message, so a new try would send it to them 2 times. */
function refusalOf(status: number): string {
  if (REDIRECTS.has(status)) return `Apprise answered ${status} and points to another address. Use the new address.`;
  switch (status) {
    case 424:
      return 'Apprise could not send to one service or more, or no service has the tag. Look in the Apprise log.';
    case 404:
      return 'Apprise has no config with this key. Check the address.';
    case 401:
      return 'Apprise refused the login. Check the user name and password.';
    case 403:
      return 'Apprise refused the request. Check the tag and the access of the config.';
    default:
      return `Apprise answered ${status}. Check the address.`;
  }
}
