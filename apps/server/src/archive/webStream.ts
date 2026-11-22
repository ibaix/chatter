import type { Readable } from 'node:stream';

/**
 * A web stream that reads the next part only when the browser takes it, so a large download never waits whole in memory.
 * (Node's Readable.toWeb() is not used: it throws when data comes after the browser stopped early.)
 * `onDone` runs once: at the end (`complete` is true), after an error, or when the browser stops the download.
 */
export function webStreamOf(source: Readable, onDone: (complete: boolean) => void = () => {}): ReadableStream<Uint8Array> {
  const parts = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let done = false;
  const finish = (complete: boolean) => {
    if (done) return;
    done = true;
    onDone(complete);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next();
        if (next.done) {
          controller.close();
          finish(true);
        } else {
          controller.enqueue(new Uint8Array(next.value));
        }
      } catch (error) {
        finish(false);
        throw error;
      }
    },
    cancel() {
      source.destroy();
      finish(false);
    },
  });
}
