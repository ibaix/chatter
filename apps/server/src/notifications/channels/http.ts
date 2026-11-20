import type { SendContext, SendResult } from './ChannelType.js';
import { networkFailure } from './networkFailure.js';
import { REDIRECTS } from './webAddress.js';

/** One JSON request of a channel type */
export interface JsonPost {
  url: string;
  /** content-type is always application/json */
  headers?: Record<string, string>;
  body: unknown;
  /** Read an error answer (not 2xx) as JSON, for a service that tells the problem in the body. Otherwise Chatter does not read the answer. */
  readJson?: boolean;
}

/** The answer of the service. `json` is undefined for a 2xx answer, when readJson is not set, or when the answer is not JSON or is too large. */
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
  const sent = response.status >= 200 && response.status < 300;
  if (request.readJson && !sent) return resultOf({ status: response.status, json: await jsonOf(response) });
  // Chatter does not read the answer. A failure to close it must not send the message again.
  response.body?.cancel().catch(() => {});
  return resultOf({ status: response.status, json: undefined });
}

/** An error answer is short. A Pi can have 512 MB of RAM, so Chatter reads no more of an answer than this. */
const MAX_ERROR_BYTES = 64 * 1024;

/** The JSON of the answer, or undefined when it is not JSON, is too large, or stops before its end */
async function jsonOf(response: Response): Promise<unknown> {
  const text = await textUpTo(response, MAX_ERROR_BYTES);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function textUpTo(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    // The time limit ended, or the connection closed
    return undefined;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
