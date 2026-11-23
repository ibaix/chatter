import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLog } from '../logging/testSupport.js';
import { DEVICE_KEY_BYTES, loadDeviceKey, newDeviceId, readDeviceCookie, signDeviceCookie } from './deviceCookie.js';

const KEY = Buffer.alloc(DEVICE_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(DEVICE_KEY_BYTES, 8);
const DEVICE = { userId: 4, deviceId: newDeviceId() };
const PASSWORD_HASH = 'scrypt$salt$hash-of-the-password';
const USER = { passwordHash: PASSWORD_HASH, deviceEpoch: 0 };

describe('device cookie', () => {
  it('gives the user and the device back from a cookie that it signed', () => {
    const cookie = signDeviceCookie(KEY, DEVICE, USER);

    expect(readDeviceCookie(KEY, cookie, () => USER)).toEqual(DEVICE);
  });

  it('gives a new device ID each time', () => {
    expect(newDeviceId()).not.toBe(newDeviceId());
  });

  it('has only the user ID, the device ID and the signature: no password and no key', () => {
    const cookie = signDeviceCookie(KEY, DEVICE, USER);

    expect(cookie.split('.')).toEqual([String(DEVICE.userId), DEVICE.deviceId, expect.any(String)]);
    expect(cookie).not.toContain('scrypt');
    expect(cookie).not.toContain(KEY.toString('base64url'));
  });

  it('refuses a cookie when the password of the user changed', () => {
    const cookie = signDeviceCookie(KEY, DEVICE, USER);
    expect(readDeviceCookie(KEY, cookie, () => ({ ...USER, passwordHash: 'scrypt$salt$hash-of-a-new-password' }))).toBeNull();
  });

  it('refuses a cookie from before the device epoch of the user changed', () => {
    const cookie = signDeviceCookie(KEY, DEVICE, USER);
    expect(readDeviceCookie(KEY, cookie, () => ({ ...USER, deviceEpoch: 1 }))).toBeNull();
  });

  it('accepts a cookie that it signed after the device epoch changed', () => {
    const user = { ...USER, deviceEpoch: 3 };
    expect(readDeviceCookie(KEY, signDeviceCookie(KEY, DEVICE, user), () => user)).toEqual(DEVICE);
  });

  it('refuses a cookie when the user does not exist', () => {
    const cookie = signDeviceCookie(KEY, DEVICE, USER);
    expect(readDeviceCookie(KEY, cookie, () => null)).toBeNull();
  });

  it('refuses a cookie that a different key signed', () => {
    const cookie = signDeviceCookie(OTHER_KEY, DEVICE, USER);
    expect(readDeviceCookie(KEY, cookie, () => USER)).toBeNull();
  });

  it('refuses a cookie with a changed user ID, device ID or signature', () => {
    const [userId, deviceId, signature] = signDeviceCookie(KEY, DEVICE, USER).split('.');
    const changedSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const tampered = [
      [String(Number(userId) + 1), deviceId, signature],
      [userId, newDeviceId(), signature],
      [userId, deviceId, changedSignature],
    ];

    for (const parts of tampered) expect(readDeviceCookie(KEY, parts.join('.'), () => USER)).toBeNull();
  });

  it('refuses a cookie that is not in the right form', () => {
    for (const cookie of [undefined, '', 'abc', '4.x.y', `4.${DEVICE.deviceId}`, `-4.${DEVICE.deviceId}.${'A'.repeat(43)}`]) {
      expect(readDeviceCookie(KEY, cookie, () => USER)).toBeNull();
    }
  });
});

describe('loadDeviceKey', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'chatter-device-key-'));
  });

  afterEach(() => {
    chmodSync(folder, 0o700);
    rmSync(folder, { recursive: true, force: true });
  });

  it('makes a random key file that only the owner can read, and reads the same key again', () => {
    const file = join(folder, 'device-key');
    const key = loadDeviceKey(file);

    expect(key).toHaveLength(DEVICE_KEY_BYTES);
    expect(readFileSync(file)).toEqual(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadDeviceKey(file)).toEqual(key);
  });

  it('makes a new key when the file is too short', () => {
    const file = join(folder, 'device-key');
    writeFileSync(file, 'short', { mode: 0o644 });
    const log = captureLog();

    const key = loadDeviceKey(file);
    log.restore();

    expect(key).toHaveLength(DEVICE_KEY_BYTES);
    expect(readFileSync(file)).toEqual(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(log.text('warn')).toContain('The device key file is not valid');
  });

  // root can write to any folder
  it.skipIf(process.getuid?.() === 0)('uses a key in memory, with a warning, when it cannot write the file', () => {
    chmodSync(folder, 0o500);
    const log = captureLog();

    const key = loadDeviceKey(join(folder, 'device-key'));
    log.restore();

    expect(key).toHaveLength(DEVICE_KEY_BYTES);
    expect(log.text('warn')).toContain('Could not save the device key');
  });
});
