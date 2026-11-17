/** Checks of a web address in the form of a channel type, and the redirect answers that Chatter does not follow */

/** The answers that point to another address in the Location header. Chatter does not follow them, because a redirect changes a POST to a GET. */
export const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function isHttpAddress(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * fetch refuses an address with a user name or password in it, and its error text would show the password.
 * True also for text that is not a web address, because isHttpAddress refuses that text.
 */
export function hasNoLogin(text: string): boolean {
  if (!URL.canParse(text)) return true;
  const { username, password } = new URL(text);
  return !username && !password;
}
