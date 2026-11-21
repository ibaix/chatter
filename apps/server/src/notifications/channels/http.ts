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

/** A JSON object of an answer. Each value is unknown, so the channel type checks each value that it uses. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** The answer of the service. `json` is undefined for a 2xx answer, when readJson is not set, or when the answer is not a JSON object or is too large. */
export interface Answer {
  status: number;
  json: JsonObject | undefined;
  /** The wait of the Retry-After header of a 429 or a 503, in milliseconds. undefined without the header, or for another answer. */
  retryAfterMs?: number;
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
  const { status } = response;
  const retryAfterMs = retryAfterOf(response);
  const sent = status >= 200 && status < 300;
  if (request.readJson && !sent) return withWait(resultOf({ status, json: await jsonOf(response), retryAfterMs }), retryAfterMs);
  // Chatter does not read the answer. A failure to close it must not send the message again.
  response.body?.cancel().catch(() => {});
  return withWait(resultOf({ status, json: undefined, retryAfterMs }), retryAfterMs);
}

/**
 * The wait of the service goes on a failure that Chatter tries again, and in its text.
 * A channel type that gives its own wait also gives its own text, so Chatter keeps both.
 */
function withWait(result: SendResult, retryAfterMs: number | undefined): SendResult {
  if (result.ok || !result.retry || retryAfterMs === undefined || result.retryAfterMs !== undefined) return result;
  return { ...result, retryAfterMs, error: `${result.error} The service asks Chatter to wait ${durationText(retryAfterMs)}.` };
}

/**
 * The Retry-After header of a 429 or a 503: a number of seconds, or an HTTP date.
 * undefined for another answer, a wrong value, or a time that is not in the future.
 */
function retryAfterOf(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

/** For example "5 seconds", "12 minutes", or "7 hours and 12 minutes". Each part is rounded up, so Chatter never tells a wait that is too short. */
export function durationText(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 120) return plural(seconds, 'second');
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} and ${plural(rest, 'minute')}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** An error answer is short. A Pi can have 512 MB of RAM, so Chatter reads no more of an answer than this. */
const MAX_ERROR_BYTES = 64 * 1024;

/** The JSON object of an error answer, or undefined when it is not a JSON object, is too large, or stops before its end */
export async function jsonOf(response: Response): Promise<JsonObject | undefined> {
  const text = await textUpTo(response, MAX_ERROR_BYTES);
  if (text === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? json as JsonObject : undefined;
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
  /** The error text of an answer that a new try cannot fix, for example a wrong token. Chatter makes it only for such an answer. */
  refused: () => string;
}

/**
 * The one rule of Chatter for an HTTP answer:
 * 2xx is sent. A redirect stops, because Chatter does not follow it.
 * 408, 429 and 5xx try again later. Each other answer stops at once.
 * The text of a try again tells only what the service answered, because "Send test" does not try again.
 */
export function statusResult(status: number, texts: StatusTexts): SendResult {
  const { answered } = texts;
  if (status >= 200 && status < 300) return { ok: true, detail: texts.sent ?? answered };
  if (REDIRECTS.has(status)) {
    return { ok: false, retry: false, error: `${answered} and points to another address. ${texts.moved ?? 'Use the new address.'}` };
  }
  if (status === 429) return { ok: false, retry: true, error: `${answered}: too many requests.` };
  if (isBusy(status)) {
    return { ok: false, retry: true, error: `${answered}. The service is busy or has a problem.` };
  }
  return { ok: false, retry: false, error: texts.refused() };
}

/** 408, 429 and 5xx: the service is busy or has a problem, so a new try later can send the message */
export function isBusy(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** A service tells the reason in English. A long reason is cut. */
const MAX_REASON = 200;

/**
 * The reason of a service, for the message list: each secret is replaced with its name, and the text is cut.
 * The text has no period at the end, so the caller can put it in a sentence.
 * A secret is a text, or a RegExp with the g flag for a short secret that must match only a whole word.
 */
export function serviceReason(reason: string, secrets: ReadonlyArray<readonly [secret: string | RegExp, name: string]>): string {
  const safe = secrets.reduce((text, [secret, name]) => text.replaceAll(secret, name), reason);
  return cutText(safe, MAX_REASON).replace(/\.$/, '');
}

/** Cuts the text to the limit of the service, and does not cut an emoji in two */
export function cutText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : text;
}
