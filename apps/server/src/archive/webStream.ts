import type { Readable } from 'node:stream';

/**
 * A web stream that reads the next part only when the browser takes it, so a large download never waits whole in memory.
 * (Node's Readable.toWeb() is not used: it throws when data comes after the browser stopped early.)
 * `onDone` runs once: at the end, after an error, or when the browser stops the download.
 */
export function webStreamOf(source: Readable, onDone: () => void = () => {}): ReadableStream<Uint8Array> {
  const parts = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next();
        if (next.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(new Uint8Array(next.value));
        }
      } catch (error) {
        finish();
        throw error;
      }
    },
    cancel() {
      source.destroy();
      finish();
    },
  });
}
