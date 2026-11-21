import { describe, expect, it } from 'vitest';
import { HIDDEN, redactContext, redactText } from './redact.js';

describe('redactContext', () => {
  it('hides the value of each secret key, in any case', () => {
    expect(redactContext({
      password: 'p1', ftpPassword: 'p2', token: 't', authToken: 't2', secret: 's', Authorization: 'Bearer x',
      apiKey: 'k', cookie: 'c', machine: 'm1',
    })).toEqual({
      password: HIDDEN, ftpPassword: HIDDEN, token: HIDDEN, authToken: HIDDEN, secret: HIDDEN, Authorization: HIDDEN,
      apiKey: HIDDEN, cookie: HIDDEN, machine: 'm1',
    });
  });

  it('hides secret keys in nested objects and lists', () => {
    expect(redactContext({ channel: { name: 'Shop', config: { botToken: 'b', list: [{ password: 'x' }] } } })).toEqual({
      channel: { name: 'Shop', config: { botToken: HIDDEN, list: [{ password: HIDDEN }] } },
    });
  });

  it('hides the secrets in an address in a text value', () => {
    expect(redactContext({ url: 'https://user:pw@ntfy.sh/topic?auth=abc&x=1' })).toEqual({
      url: `https://${HIDDEN}@ntfy.sh/topic?auth=${HIDDEN}&x=1`,
    });
  });

  it('keeps an Error, so the logger can write its message and stack', () => {
    const error = new Error('Connection refused');
    expect(redactContext({ error }).error).toBe(error);
  });
});

describe('redactText', () => {
  it('hides the user info of an address', () => {
    expect(redactText('POST http://admin:hunter2@10.0.0.9:8000/notify failed')).toBe(`POST http://${HIDDEN}@10.0.0.9:8000/notify failed`);
  });

  it('hides the secret values in the query of an address', () => {
    expect(redactText('GET https://x.test/a?token=abc&page=2&api_key=k&sig=s'))
      .toBe(`GET https://x.test/a?token=${HIDDEN}&page=2&api_key=${HIDDEN}&sig=${HIDDEN}`);
  });

  it('hides key=value pairs with a secret key', () => {
    expect(redactText('Login failed password=hunter2 user=bob secret="a b"')).toBe(`Login failed password=${HIDDEN} user=bob secret=${HIDDEN}`);
  });

  it('hides a bearer token and a Telegram bot token in an address', () => {
    expect(redactText('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${HIDDEN}`);
    expect(redactText('https://api.telegram.org/bot123456:ABC-def_ghi/sendMessage'))
      .toBe(`https://api.telegram.org/bot${HIDDEN}/sendMessage`);
  });

  it('keeps a normal line as it is', () => {
    const line = '2026-11-12T10:00:00.000Z WARN  [machines] Machine went offline machine=m1 reason="Connection refused"';
    expect(redactText(line)).toBe(line);
  });
});
