import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '../logging/logger.js';

const log = createLogger('auth');

/**
 * A "known device" cookie: a browser where a user logged in before.
 * A login from a known device has its own small limit, so a person on the network
 * who sends wrong passwords for a user cannot lock that user out of their own browser.
 *
 * The cookie is "<user ID>.<device ID>.<signature>". The signature is an HMAC with a key of the server,
 * over the user ID, the device ID and the password hash of the user. So the cookie stops when the password
 * changes or the user is removed. The cookie has no password, no password hash and no key.
 */

export const DEVICE_KEY_BYTES = 32;
/** The name of the key file in the data folder */
export const DEVICE_KEY_FILE = 'device-key';
const DEVICE_ID_BYTES = 16;
/** Changes when the form of the cookie changes, so an old cookie is not read the wrong way */
const SIGNATURE_LABEL = 'chatter-device-v1';
const COOKIE_FORM = /^([1-9]\d{0,15})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
/** Only the owner can read and write the key file */
const OWNER_ONLY = 0o600;

/** The browser of a user, as its device cookie tells it */
export interface KnownDevice {
  userId: number;
  deviceId: string;
}

/** A random ID for a browser that logs in for the first time */
export const newDeviceId = () => randomBytes(DEVICE_ID_BYTES).toString('base64url');

const signatureOf = (key: Buffer, { userId, deviceId }: KnownDevice, passwordHash: string) =>
  createHmac('sha256', key).update(`${SIGNATURE_LABEL}\n${userId}\n${deviceId}\n${passwordHash}`).digest();

/** The value of the device cookie for this user and device */
export function signDeviceCookie(key: Buffer, device: KnownDevice, passwordHash: string): string {
  return `${device.userId}.${device.deviceId}.${signatureOf(key, device, passwordHash).toString('base64url')}`;
}

/**
 * The user and the device of a cookie that this server signed, or null.
 * `passwordHashOf` gives the password hash of a user ID now, or null when the user does not exist.
 */
export function readDeviceCookie(
  key: Buffer,
  cookie: string | undefined,
  passwordHashOf: (userId: number) => string | null,
): KnownDevice | null {
  const parts = COOKIE_FORM.exec(cookie ?? '');
  if (!parts) return null;
  const device = { userId: Number(parts[1]), deviceId: parts[2] };
  const passwordHash = passwordHashOf(device.userId);
  if (passwordHash === null) return null;
  const signature = Buffer.from(parts[3], 'base64url');
  const expected = signatureOf(key, device, passwordHash);
  return signature.length === expected.length && timingSafeEqual(signature, expected) ? device : null;
}

/**
 * The key that signs the device cookies, from a file in the data folder. The first start makes the file.
 * When the file cannot be saved, the key is kept in memory only: then the device cookies stop at the next start.
 */
export function loadDeviceKey(file: string): Buffer {
  const saved = readKeyFile(file);
  if (saved) return saved;
  const key = randomBytes(DEVICE_KEY_BYTES);
  try {
    writeFileSync(file, key, { mode: OWNER_ONLY });
    // The mode above is only for a new file. A file that was not valid can have a different mode.
    chmodSync(file, OWNER_ONLY);
  } catch (error) {
    log.warn('Could not save the device key. Known browsers must log in again after a restart.', { file, error });
  }
  return key;
}

function readKeyFile(file: string): Buffer | null {
  let key: Buffer;
  try {
    key = readFileSync(file);
  } catch {
    return null;
  }
  if (key.length >= DEVICE_KEY_BYTES) return key;
  log.warn('The device key file is not valid. Chatter makes a new key, so each browser is new again.', { file });
  return null;
}
