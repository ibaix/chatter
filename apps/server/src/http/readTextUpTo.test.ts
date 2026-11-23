import { describe, it, expect, vi } from 'vitest';
import { BodyTooLargeError, readTextUpTo } from './readTextUpTo.js';

/** A response whose body comes in these parts, and a check if the reader cancelled the body */
function responseOf(parts: Uint8Array[], headers: Record<string, string> = {}): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part) controller.enqueue(part);
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { headers }), cancelled: () => cancelled };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('readTextUpTo', () => {
  it('reads a body of the limit size', async () => {
    const { response } = responseOf([bytes('12345'), bytes('67890')]);

    expect(await readTextUpTo(response, 10)).toBe('1234567890');
  });

  it('decodes a character that is split over two parts', async () => {
    const euro = bytes('€');
    const { response } = responseOf([euro.slice(0, 1), euro.slice(1)]);

    expect(await readTextUpTo(response, 10)).toBe('€');
  });

  it('stops a body larger than the limit with a neutral error, and cancels the body', async () => {
    const { response, cancelled } = responseOf([bytes('123456'), bytes('78901'), bytes('more')]);

    const error = await readTextUpTo(response, 10).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect((error as BodyTooLargeError).maxBytes).toBe(10);
    expect((error as Error).message).toBe('The reply is larger than 10 bytes.');
    await vi.waitFor(() => expect(cancelled()).toBe(true));
  });

  it('stops before it reads when the Content-Length is larger than the limit', async () => {
    const { response, cancelled } = responseOf([bytes('x')], { 'Content-Length': '11' });

    await expect(readTextUpTo(response, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled()).toBe(true);
  });

  it('gives an empty text for a response with no body', async () => {
    expect(await readTextUpTo(new Response(null), 10)).toBe('');
  });
});
