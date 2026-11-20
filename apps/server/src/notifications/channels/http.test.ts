import { describe, expect, it } from 'vitest';
import type { SendContext } from './ChannelType.js';
import { type Answer, cutText, postJson, statusResult } from './http.js';

interface SentRequest {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const requests: SentRequest[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return answer();
  }) as typeof globalThis.fetch;
  return { requests, context: (): SendContext => ({ fetch, signal: new AbortController().signal }) };
}

const sentOk = () => ({ ok: true as const, detail: 'sent' });

describe('postJson', () => {
  it('sends the body as JSON with POST, does not follow a redirect, and passes the signal', async () => {
    const service = fakeFetch(() => new Response(null, { status: 204 }));
    const context = service.context();

    await postJson(context, 'the service', { url: 'https://example.com/hook', headers: { authorization: 'Bearer x' }, body: { a: 1 } }, sentOk);

    const [{ url, init }] = service.requests;
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(context.signal);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer x');
    expect(JSON.parse(String(init.body))).toEqual({ a: 1 });
  });

  it('gives the status to the result function, without the body when readJson is not set', async () => {
    const answers: Answer[] = [];
    const service = fakeFetch(() => new Response('{"ok":false}', { status: 400 }));

    const result = await postJson(service.context(), 'the service', { url: 'https://example.com', body: {} }, answer => {
      answers.push(answer);
      return { ok: false, retry: false, error: 'no' };
    });

    expect(result).toEqual({ ok: false, retry: false, error: 'no' });
    expect(answers).toEqual([{ status: 400, json: undefined }]);
  });

  it('reads the JSON answer when readJson is set', async () => {
    const answers: Answer[] = [];
    const service = fakeFetch(() => new Response('{"description":"chat not found"}', { status: 400 }));

    await postJson(service.context(), 'the service', { url: 'https://example.com', body: {}, readJson: true }, answer => {
      answers.push(answer);
      return sentOk();
    });

    expect(answers).toEqual([{ status: 400, json: { description: 'chat not found' } }]);
  });

  it('gives no JSON when the answer is not JSON', async () => {
    const answers: Answer[] = [];
    const service = fakeFetch(() => new Response('<html>busy</html>', { status: 502 }));

    await postJson(service.context(), 'the service', { url: 'https://example.com', body: {}, readJson: true }, answer => {
      answers.push(answer);
      return sentOk();
    });

    expect(answers).toEqual([{ status: 502, json: undefined }]);
  });

  it('does not read a 2xx answer, also when readJson is set, and closes it', async () => {
    const answers: Answer[] = [];
    const response = new Response('{"ok":true}', { status: 200 });
    let closed = false;
    response.body!.cancel = async () => { closed = true; };

    await postJson(fakeFetch(() => response).context(), 'the service', { url: 'https://example.com', body: {}, readJson: true }, answer => {
      answers.push(answer);
      return sentOk();
    });

    expect(answers).toEqual([{ status: 200, json: undefined }]);
    expect(closed).toBe(true);
  });

  it('reads at most 64 KB of an error answer, so a large answer cannot fill the memory of a Pi', async () => {
    const answers: Answer[] = [];
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let readBytes = 0;
    let closed = false;
    // Valid JSON of 1 MB: {"error":"xxx…"}
    const parts = [new TextEncoder().encode('{"error":"'), ...Array.from({ length: 64 }, () => chunk), new TextEncoder().encode('"}')];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts.shift();
        if (!part) return controller.close();
        readBytes += part.byteLength;
        controller.enqueue(part);
      },
      cancel() { closed = true; },
    }, { highWaterMark: 0 });

    await postJson(fakeFetch(() => new Response(body, { status: 400 })).context(), 'the service', { url: 'https://example.com', body: {}, readJson: true }, answer => {
      answers.push(answer);
      return sentOk();
    });

    expect(answers.map(answer => answer.status)).toEqual([400]);
    expect(answers[0].json === undefined).toBe(true);
    expect(readBytes).toBeLessThanOrEqual(64 * 1024 + chunk.byteLength);
    expect(closed).toBe(true);
  });

  it('gives the result, also when Chatter cannot close the answer', async () => {
    const response = new Response('ok', { status: 200 });
    response.body!.cancel = () => Promise.reject(new Error('the time limit ended'));

    expect(await postJson(fakeFetch(() => response).context(), 'the service', { url: 'https://example.com', body: {} }, sentOk))
      .toEqual({ ok: true, detail: 'sent' });
  });

  it('gives a network failure with the name of the target, and without the address', async () => {
    const failed = fakeFetch(() => {
      throw new TypeError('fetch failed for https://example.com/secret-token', { cause: { code: 'ENOTFOUND' } });
    });

    expect(await postJson(failed.context(), 'the service', { url: 'https://example.com/secret-token', body: {} }, sentOk))
      .toEqual({ ok: false, retry: true, error: 'Chatter could not reach the service (ENOTFOUND).' });
  });
});

describe('statusResult', () => {
  const refused = (status: number) => `Refused ${status}.`;

  it.each([200, 201, 204])('is sent for %i, with the answer as the detail', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused })).toEqual({ ok: true, detail: `X answered ${status}` });
  });

  it('uses the sent text when the channel gives one', () => {
    expect(statusResult(200, { answered: 'X answered 200', sent: 'X sent it', refused })).toEqual({ ok: true, detail: 'X sent it' });
  });

  it.each([301, 302, 303, 307, 308])('stops at once for the redirect %i', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused }))
      .toEqual({ ok: false, retry: false, error: `X answered ${status} and points to another address. Use the new address.` });
  });

  it('uses the moved text of the channel for a redirect', () => {
    expect(statusResult(301, { answered: 'X answered 301', moved: 'Copy it again.', refused }))
      .toEqual({ ok: false, retry: false, error: 'X answered 301 and points to another address. Copy it again.' });
  });

  it.each([408, 429, 500, 503])('tries again later for %i', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused }))
      .toEqual({ ok: false, retry: true, error: `X answered ${status}. Chatter tries again later.` });
  });

  it.each([400, 401, 404, 409])('stops at once for %i, with the text of the channel', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused }))
      .toEqual({ ok: false, retry: false, error: `Refused ${status}.` });
  });
});

describe('cutText', () => {
  it('keeps a short text', () => {
    expect(cutText('abc', 5)).toBe('abc');
  });

  it('cuts a long text to the limit', () => {
    expect(cutText('abcdef', 4)).toBe('abcd');
  });

  it('does not cut an emoji in two at the limit', () => {
    expect(cutText('abc🔥', 4)).toBe('abc');
  });
});
