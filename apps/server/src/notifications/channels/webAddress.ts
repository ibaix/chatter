/** Checks of a web address in the form of a channel type */

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
