/**
 * Removes secrets from the log before a line is written, kept, or sent out (log download, support bundle).
 * The log must never hold a password, a token, or a secret of a notification channel.
 */

/** The text in place of a secret */
export const HIDDEN = '[hidden]';

/** A detail with one of these words in its name holds a secret, for example ftpPassword or botToken */
const SECRET_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|cookie|credential|signature/i;
/** The names of query values in an address that hold a secret */
const SECRET_QUERY_KEY = /^(.*pass.*|.*token.*|.*secret.*|.*key.*|auth|sig|signature|code)$/i;
/** Nested details deeper than this are not read */
const MAX_DEPTH = 5;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** The details of a log line, with each secret value hidden. Errors stay, because their text goes through redactText. */
export function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  return redactObject(context, 0);
}

function redactObject(object: Record<string, unknown>, depth: number): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, isSecretKey(key) ? HIDDEN : redactValue(value, depth + 1)]));
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error || value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return HIDDEN;
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  return redactObject(value as Record<string, unknown>, depth);
}

const URL_USER_INFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const URL_QUERY = /\?[^\s"]*/g;
const KEY_VALUE = /\b([A-Za-z_]*(?:pass(?:word)?|token|secret|authorization|api[-_]?key|cookie)[A-Za-z_]*)=("(?:[^"\\]|\\.)*"|[^\s&]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
/** A Telegram bot token is in the path of the address: /bot<number>:<text>/ */
const TELEGRAM_BOT = /\/bot\d+:[A-Za-z0-9_-]+/g;

/** A line of text with the secrets hidden: the user info and secret query values of an address, secret key=value pairs, and tokens */
export function redactText(text: string): string {
  return text
    .replace(URL_USER_INFO, `$1${HIDDEN}@`)
    .replace(URL_QUERY, redactQuery)
    .replace(KEY_VALUE, `$1=${HIDDEN}`)
    .replace(BEARER, `$1 ${HIDDEN}`)
    .replace(TELEGRAM_BOT, `/bot${HIDDEN}`);
}

function redactQuery(query: string): string {
  return query.replace(/([?&])([^=&\s]+)=([^&\s"]*)/g, (pair, separator: string, key: string) =>
    (SECRET_QUERY_KEY.test(key) ? `${separator}${key}=${HIDDEN}` : pair));
}
