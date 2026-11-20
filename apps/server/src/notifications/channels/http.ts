import type { SendContext, SendResult } from './ChannelType.js';
import { networkFailure } from './networkFailure.js';
import { REDIRECTS } from './webAddress.js';

/** One JSON request of a channel type */
export interface JsonPost {
  url: string;
  /** content-type is always application/json */
  headers?: Record<string, string>;
  body: unknown;
  /** Read the answer as JSON, for a service that tells the problem in the body. Otherwise Chatter does not read the answer. */
  readJson?: boolean;
}

/** The answer of the service. `json` is undefined when readJson is not set, or when the answer is not JSON. */
export interface Answer {
  status: number;
  json: unknown;
}

/**
 * POSTs the body as JSON and gives the answer to `resultOf`. Never throws for a network failure.
 * `target` names the service in the network failure text, for example "Discord" or "the address".
 * The text of a network failure never has the web address in it, because the address can have a token in it.
 */
export async function postJson(
  { fetch, signal }: SendContext, target: string, request: JsonPost, resultOf: (answer: Answer) => SendResult,
): Promise<SendResult> {
  let response: Response;
  try {
    // A redirect would change the POST to a GET, so Chatter does not follow it
    response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    return networkFailure(error, target);
  }
  if (request.readJson) return resultOf({ status: response.status, json: await jsonOf(response) });
  // Chatter does not read the answer. A failure to close it must not send the message again.
  response.body?.cancel().catch(() => {});
  return resultOf({ status: response.status, json: undefined });
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export interface StatusTexts {
  /** For example "Discord answered 404". The start of the redirect and try-again texts. */
  answered: string;
  /** The detail of a sent message. Without it, `answered`. */
  sent?: string;
  /** What to do after a redirect. Without it, "Use the new address." */
  moved?: string;
  /** The error text of an answer that a new try cannot fix, for example a wrong token */
  refused: (status: number) => string;
}

/**
 * The one rule of Chatter for an HTTP answer:
 * 2xx is sent. A redirect stops, because Chatter does not follow it.
 * 408, 429 and 5xx try again later. Each other answer stops at once.
 */
export function statusResult(status: number, texts: StatusTexts): SendResult {
  const { answered } = texts;
  if (status >= 200 && status < 300) return { ok: true, detail: texts.sent ?? answered };
  if (REDIRECTS.has(status)) {
    return { ok: false, retry: false, error: `${answered} and points to another address. ${texts.moved ?? 'Use the new address.'}` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, retry: true, error: `${answered}. Chatter tries again later.` };
  }
  return { ok: false, retry: false, error: texts.refused(status) };
}

/** Cuts the text to the limit of the service, and does not cut an emoji in two */
export function cutText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : text;
}
