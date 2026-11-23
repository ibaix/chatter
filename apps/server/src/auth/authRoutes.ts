import { roleCan, type Permission } from '@local-chatter/shared';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { checkedJson } from '../routes/checks.js';
import { changePasswordSchema, logInSchema, setUpSchema } from '../routes/schemas.js';
import type { Auth, CurrentUser, Login, UserSession } from './Auth.js';
import { LOCK_MINUTES, type LoginLimiter } from './LoginLimiter.js';
import type { LoginLog, LoginResult } from './loginLog.js';
import type { ProxySettings } from './proxySettings.js';
import type { RequestOrigin } from './proxyTrust.js';
import { originOf } from './requestOrigin.js';
import { SESSION_LIFETIME_SECONDS, type SessionClient } from './sessionStore.js';
import { UsernameTakenError } from './userStore.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('auth');

/**
 * Log in, log out, and the first-run account setup.
 * A browser keeps its login in a cookie.
 * A program sends the username and password with each request (HTTP Basic: "Authorization: Basic <base64 of name:password>").
 */

export const SESSION_COOKIE = 'chatterbox_session';
/** The cookie goes with each request to Chatter, for the API and for the pages */
const SESSION_COOKIE_PATH = '/';
/** Tells that this browser logged in as the user before. See deviceCookie.ts. */
export const DEVICE_COOKIE = 'chatterbox_device';
/** Only the login routes read the device cookie, so the browser sends it nowhere else */
const DEVICE_COOKIE_PATH = '/api/auth';
/**
 * 400 days: longer than the session (1 year), so the browser is still known when its session ends and the user
 * must log in again. Each login gives a new cookie. Browsers keep a cookie for at most 400 days (RFC 6265bis),
 * so a longer value has no effect.
 */
const DEVICE_COOKIE_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
// The scheme name ignores case (RFC 7235)
const BASIC = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i;
/** Longer than any username and password that the setup allows */
const MAX_BASIC_LENGTH = 512;

/** The username and password of an "Authorization: Basic" header, or null */
function basicLogin(header: string | undefined): Login | null {
  const encoded = BASIC.exec(header ?? '')?.[1];
  if (!encoded || encoded.length > MAX_BASIC_LENGTH) return null;
  const credentials = Buffer.from(encoded, 'base64').toString('utf8');
  // Only the first colon splits: a password can have colons in it, but a username cannot
  const colonIndex = credentials.indexOf(':');
  if (colonIndex < 0) return null;
  return { username: credentials.slice(0, colonIndex), password: credentials.slice(colonIndex + 1) };
}

/** After requireLogin, each route can read the user who sent the request: c.var.user */
export type LoggedInEnv = { Variables: { user: CurrentUser } };

/** What the login checks need */
export interface LoginGuard {
  auth: Auth;
  limiter: LoginLimiter;
  loginLog: LoginLog;
  proxySettings: ProxySettings;
}

/** The session of the browser that sent the request, or null */
export function currentSession(c: Context, auth: Auth): UserSession | null {
  const token = getCookie(c, SESSION_COOKIE);
  return token === undefined ? null : auth.sessionOf(token);
}

/** The browser that logs in, as the list of sessions shows it */
function clientOf(c: Context, origin: RequestOrigin): SessionClient {
  return { userAgent: c.req.header('User-Agent') ?? '', address: origin.address };
}

function setSessionCookie(c: Context, origin: RequestOrigin, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    // Page scripts cannot read it, and other sites cannot send it with a form
    httpOnly: true,
    sameSite: 'Lax',
    // The browser sends it only over HTTPS, when the browser used HTTPS to log in
    secure: origin.isHttps,
    path: SESSION_COOKIE_PATH,
    maxAge: SESSION_LIFETIME_SECONDS,
  });
}

/** The device ID of a valid device cookie of this browser for this username, or undefined */
function knownDevice(c: Context, auth: Auth, username: string): string | undefined {
  return auth.knownDeviceOf(getCookie(c, DEVICE_COOKIE), username) ?? undefined;
}

/** Remember this browser as a known device of the user, with a new device ID */
function setDeviceCookie(c: Context, auth: Auth, origin: RequestOrigin, username: string): void {
  const value = auth.deviceCookieFor(username);
  if (value === null) return;
  setCookie(c, DEVICE_COOKIE, value, {
    httpOnly: true,
    // Only Chatter's own pages send it, also for a link from another site
    sameSite: 'Strict',
    secure: origin.isHttps,
    path: DEVICE_COOKIE_PATH,
    maxAge: DEVICE_COOKIE_LIFETIME_SECONDS,
  });
}

/** Give the browser its session cookie and its device cookie, and tell it that it is logged in */
function replyLoggedIn(c: Context, auth: Auth, origin: RequestOrigin, token: string, username: string) {
  setSessionCookie(c, origin, token);
  setDeviceCookie(c, auth, origin, username);
  return c.json({ loggedIn: true });
}

export const logInFirst = (c: Context) => c.json({ error: 'Log in first' }, 401);
const tooManyTries = (c: Context) =>
  c.json({
    error: `Too many wrong passwords. Try again in up to ${LOCK_MINUTES} minutes, or ask an Admin to unlock you in Settings > Logins.`,
  }, 429);
const wrongLogin = (c: Context) => c.json({ error: 'Wrong username or password' }, 401);

type Checked<Value> = { ok: true; value: Value } | { ok: false; reply: Response };

/** One try to prove who the caller is, with a password */
interface PasswordTry<Value> {
  username: string;
  /** The device ID of a valid device cookie for this username. Its tries count only for that device. */
  device?: string;
  /** What the login log says when the password is right */
  success: Extract<LoginResult, 'logged-in' | 'password-changed'>;
  /** Gives null for a wrong username or password */
  check: () => Promise<Value | null>;
}

/** Check a password from the caller. Each try counts against the caller's address and the username, and goes in the login log. */
async function withPasswordCheck<Value>(
  c: Context,
  { auth, limiter, loginLog }: LoginGuard,
  { address }: RequestOrigin,
  { username, device, success, check }: PasswordTry<Value>,
): Promise<Checked<Value>> {
  const recordTry = (result: LoginResult) =>
    withoutFailing('[Login log] Could not save a login try', () => loginLog.record({ username, address, result }));
  if (limiter.isBlocked(address, username, device)) {
    if (limiter.isFirstBlockedTry(address, username, device)) recordTry('locked');
    return { ok: false, reply: tooManyTries(c) };
  }
  // Count the try before the slow check, so tries sent at the same time cannot all get past the block
  limiter.recordAttempt(address, username, device);
  const value = await check();
  if (value === null) {
    recordTry(auth.hasUser(username) ? 'wrong-password' : 'no-such-user');
    return { ok: false, reply: wrongLogin(c) };
  }
  limiter.recordSuccess(address, username, device);
  recordTry(success);
  return { ok: true, value };
}

/** A note that cannot be saved (for example, on a full disk) must not stop a login or a request */
function withoutFailing(message: string, save: () => void): void {
  try {
    save();
  } catch (error) {
    log.error(message, { error });
  }
}

/** Stops each request that has no valid login. Sets c.var.user for the routes after it. */
export function requireLogin(guard: LoginGuard) {
  const { auth, proxySettings } = guard;
  return createMiddleware<LoggedInEnv>(async (c, next) => {
    const session = currentSession(c, auth);
    if (session) {
      const { address } = originOf(c, proxySettings);
      withoutFailing('[Sessions] Could not save when a browser was used', () => auth.markSeen(session, address));
      c.set('user', session.user);
      return next();
    }

    // A program has no device cookie, so this login always has the normal limits
    const login = basicLogin(c.req.header('Authorization'));
    if (!login) return logInFirst(c);
    // A known login is not logged, because a program sends it with each request
    const knownUser = auth.knownUserOf(login);
    if (knownUser) {
      c.set('user', knownUser);
      return next();
    }

    const checked = await withPasswordCheck(c, guard, originOf(c, proxySettings), {
      username: login.username,
      success: 'logged-in',
      check: () => auth.userOf(login),
    });
    if (!checked.ok) return checked.reply;
    c.set('user', checked.value);
    return next();
  });
}

/** Stops a request from a browser that is not logged in, before the route reads the body. Sets c.var.user. */
function requireBrowserLogin(auth: Auth) {
  return createMiddleware<LoggedInEnv>(async (c, next) => {
    const session = currentSession(c, auth);
    if (!session) return logInFirst(c);
    c.set('user', session.user);
    return next();
  });
}

/** Stops the request when the role of the user cannot do this. Use it only after requireLogin. */
export function requirePermission(permission: Permission) {
  return createMiddleware<LoggedInEnv>(async (c, next) => {
    if (roleCan(c.var.user.role, permission)) return next();
    return c.json({ error: 'Your role cannot do this. Ask an admin.' }, 403);
  });
}

export function authRoutes(guard: LoginGuard) {
  const { auth, proxySettings } = guard;
  return new Hono()
    .get('/auth/status', c => {
      const user = currentSession(c, auth)?.user ?? null;
      return c.json({
        setupNeeded: !auth.isSetUp(),
        loggedIn: user !== null,
        user: user && { username: user.username, role: user.role },
      });
    })

    // Only the first visitor can do this: when an admin exists, the reply is 409
    .post('/auth/setup', checkedJson(setUpSchema), async c => {
      const origin = originOf(c, proxySettings);
      try {
        const setUp = c.req.valid('json');
        const token = await auth.setUp(setUp, clientOf(c, origin));
        if (!token) return c.json({ error: 'The account is already set up' }, 409);
        return replyLoggedIn(c, auth, origin, token, setUp.username);
      } catch (error) {
        // After a password reset from the command line, a user who is not an admin can have this username
        if (error instanceof UsernameTakenError) return c.json({ error: error.message }, 409);
        throw error;
      }
    })

    .post('/auth/login', checkedJson(logInSchema), async c => {
      const login = c.req.valid('json');
      const origin = originOf(c, proxySettings);
      const checked = await withPasswordCheck(c, guard, origin, {
        username: login.username,
        device: knownDevice(c, auth, login.username),
        success: 'logged-in',
        check: () => auth.logIn(login, clientOf(c, origin)),
      });
      if (!checked.ok) return checked.reply;
      return replyLoggedIn(c, auth, origin, checked.value, login.username);
    })

    .post('/auth/logout', c => {
      const session = currentSession(c, auth);
      if (session) auth.logOut(session);
      deleteCookie(c, SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
      return c.json({ loggedIn: false });
    })

    // Only a browser that is logged in can do this. A new password logs out every other browser.
    .post('/auth/password', requireBrowserLogin(auth), checkedJson(changePasswordSchema), async c => {
      const { user } = c.var;
      const passwordChange = c.req.valid('json');
      const origin = originOf(c, proxySettings);
      const checked = await withPasswordCheck(c, guard, origin, {
        username: user.username,
        device: knownDevice(c, auth, user.username),
        success: 'password-changed',
        check: () => auth.changePassword(user, passwordChange, clientOf(c, origin)),
      });
      if (!checked.ok) return checked.reply;
      // The new password stops the old device cookie, so the browser gets a new one
      return replyLoggedIn(c, auth, origin, checked.value, user.username);
    });
}
