import { z } from 'zod';
import type { ChannelDefinition, OutgoingMessage, SendResult } from './ChannelType.js';
import { postJson, statusResult } from './http.js';
import { hasNoLogin, isHttpAddress } from './webAddress.js';

const BAD_URL = 'Web address must start with http:// or https://';
const LOGIN_IN_URL = 'Remove the user name and password from the web address. Put a password in Secret.';
const BAD_SECRET = 'Secret can have only plain letters, digits, and signs, with no spaces';

/** fetch refuses a header value with other characters */
const HEADER_SAFE = /^[\x21-\x7e]*$/;

const webhookSettings = z.object({
  url: z.string({ error: BAD_URL }).trim()
    .refine(isHttpAddress, BAD_URL)
    .refine(hasNoLogin, LOGIN_IN_URL),
  secret: z.string().trim().regex(HEADER_SAFE, BAD_SECRET).optional(),
});

type WebhookSettings = z.infer<typeof webhookSettings>;

/**
 * Sends each message as JSON to a web address: Slack, ntfy, Home Assistant, or an app of the shop.
 * Slack shows the `text` line. Other apps can read each field.
 */
export const webhookChannel: ChannelDefinition<WebhookSettings> = {
  id: 'webhook',
  name: 'Webhook',
  fields: [
    {
      key: 'url', label: 'Web address', kind: 'url', required: true, mono: true,
      hint: 'For Slack, make an incoming webhook in Slack and paste its address here.',
    },
    {
      key: 'secret', label: 'Secret (optional)', kind: 'secret', required: false, mono: true,
      hint: 'Chatter sends it in the Authorization header, so the other app knows the message is from Chatter.',
    },
  ],
  settings: webhookSettings,
  send(settings, message, context) {
    const headers = settings.secret ? { authorization: `Bearer ${settings.secret}` } : undefined;
    return postJson(context, 'the address', { url: settings.url, headers, body: webhookBody(message) }, ({ status }) => resultOf(status));
  },
};

function webhookBody(message: OutgoingMessage) {
  return {
    text: message.text,
    state: message.kind,
    level: message.severity,
    machine: message.machine,
    alert: message.alertName,
    summary: message.summary,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
    link: message.link,
  };
}

function resultOf(status: number): SendResult {
  const answered = `The address answered ${status}`;
  return statusResult(status, {
    answered,
    refused: () => `${answered}. ${status === 401 || status === 403 ? 'Check the secret.' : 'Check the web address.'}`,
  });
}
