import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, cutText, durationText, postJson, serviceReason, statusResult } from './http.js';
import { fakeFetch } from './testSupport.js';

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

  describe('Retry-After', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function busy(status: number, retryAfter: string) {
      return fakeFetch(() => new Response(null, { status, headers: { 'retry-after': retryAfter } }));
    }

    function busyResult(answer: Answer) {
      return statusResult(answer.status, { answered: `X answered ${answer.status}`, refused: () => 'Refused.' });
    }

    it('gives the wait of a 429 in seconds, and tells it in the text', async () => {
      const answers: Answer[] = [];

      const result = await postJson(busy(429, '120').context(), 'X', { url: 'https://example.com', body: {} }, answer => {
        answers.push(answer);
        return busyResult(answer);
      });

      expect(answers).toEqual([{ status: 429, json: undefined, retryAfterMs: 120_000 }]);
      expect(result).toEqual({
        ok: false, retry: true, retryAfterMs: 120_000, error: 'X answered 429: too many requests. The service asks Chatter to wait 2 minutes.',
      });
    });

    it('reads the wait of a 503 as an HTTP date', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 13, 9, 0) });

      const result = await postJson(busy(503, 'Fri, 13 Nov 2026 09:00:30 GMT').context(), 'X', { url: 'https://example.com', body: {} }, busyResult);

      expect(result).toEqual({
        ok: false, retry: true, retryAfterMs: 30_000,
        error: 'X answered 503. The service is busy or has a problem. The service asks Chatter to wait 30 seconds.',
      });
    });

    it('gives no wait for a date in the past, a wrong value, or an answer that is not 429 or 503', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 13, 9, 0) });
      const request = { url: 'https://example.com', body: {} };

      for (const [status, value] of [[429, 'Fri, 13 Nov 2026 08:00:00 GMT'], [429, 'soon'], [429, '-5'], [500, '60'], [400, '60']] as const) {
        const result = await postJson(busy(status, value).context(), 'X', request, busyResult);
        expect(result).not.toHaveProperty('retryAfterMs');
        expect(result.ok ? '' : result.error).not.toContain('wait');
      }
    });

    it('keeps the wait and the text of a channel type that gives its own', async () => {
      const own = { ok: false as const, retry: true, retryAfterMs: 60_000, error: 'Own text.' };

      expect(await postJson(busy(429, '5').context(), 'X', { url: 'https://example.com', body: {} }, () => own)).toEqual(own);
    });

    it('gives no wait to a failure that Chatter does not try again', async () => {
      const refusal = { ok: false as const, retry: false, error: 'Refused.' };

      expect(await postJson(busy(429, '5').context(), 'X', { url: 'https://example.com', body: {} }, () => refusal)).toEqual(refusal);
    });
  });
});

describe('durationText', () => {
  it.each([
    [1_000, '1 second'], [5_000, '5 seconds'], [4_200, '5 seconds'], [119_000, '119 seconds'], [120_000, '2 minutes'],
    [61 * 60_000, '61 minutes'], [2 * 3_600_000, '2 hours'], [3_600_000 * 7 + 12 * 60_000, '7 hours and 12 minutes'],
    [3_600_000 * 2 + 60_000, '2 hours and 1 minute'],
  ])('tells %i ms as "%s"', (milliseconds, text) => {
    expect(durationText(milliseconds)).toBe(text);
  });
});

describe('statusResult', () => {
  const refused = () => 'Refused.';

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

  // The text is also the result of "Send test", which sends one time only. So it does not say that Chatter tries again.
  it.each([408, 500, 503])('tries again later for %i, and tells that the service is busy', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused }))
      .toEqual({ ok: false, retry: true, error: `X answered ${status}. The service is busy or has a problem.` });
  });

  it('tries again later for 429, and tells that Chatter sent too many requests', () => {
    expect(statusResult(429, { answered: 'X answered 429', refused }))
      .toEqual({ ok: false, retry: true, error: 'X answered 429: too many requests.' });
  });

  it.each([400, 401, 404, 409])('stops at once for %i, with the text of the channel', status => {
    expect(statusResult(status, { answered: `X answered ${status}`, refused }))
      .toEqual({ ok: false, retry: false, error: 'Refused.' });
  });

  it.each([200, 301, 429, 500])('does not make the refusal text for %i, which is not a refusal', status => {
    statusResult(status, { answered: `X answered ${status}`, refused: () => { throw new Error('not a refusal'); } });
  });
});

describe('serviceReason', () => {
  it('replaces each secret with its name', () => {
    expect(serviceReason('bad token 123:abc for chat x', [['123:abc', '(bot token)']])).toBe('bad token (bot token) for chat x');
  });

  it('replaces a RegExp secret only where it matches', () => {
    expect(serviceReason('topic a is bad', [[/\ba\b/g, '(topic)']])).toBe('topic (topic) is bad');
  });

  it('cuts a long reason to 200 characters', () => {
    expect(serviceReason('x'.repeat(300), [])).toBe('x'.repeat(200));
  });

  it('removes the period at the end, so the caller can put the reason in a sentence', () => {
    expect(serviceReason('message text is empty.', [])).toBe('message text is empty');
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
