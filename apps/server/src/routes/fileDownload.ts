import { Writable } from 'node:stream';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';

/** The bytes that wait in the stream for the reader. More bytes wait until the reader takes some. */
const STREAM_QUEUE_BYTES = 64 * 1024;

/**
 * Start to read a file from the machine, and give it as a stream.
 *
 * The promise waits for the first bytes (or the end of an empty file).
 * So when the machine refuses the download, the caller gets the error
 * while it can still send an error reply.
 * An error after the first bytes stops the stream.
 *
 * Node's Readable.toWeb() is not used: it throws (and stops the server)
 * when data arrives after the reader stopped early.
 *
 * A slow reader slows the download: when the queue of the stream is full, the write waits for the next
 * pull of the reader. Then the output is full too, and the download stops to read from the machine.
 */
export async function downloadAsStream(connector: BaseMachineConnector, filePath: string): Promise<ReadableStream<Uint8Array>> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // When the reader stops early, the download on the machine stops too. A chunk that is on its way is dropped. After the
  // stream ends, a late write is dropped too.
  let isStreamOpen = true;
  const stopDownload = new AbortController();
  /** The end of the write that waits for the reader */
  let finishWaitingWrite: (() => void) | undefined;
  const continueWriting = () => {
    const finish = finishWaitingWrite;
    finishWaitingWrite = undefined;
    finish?.();
  };
  /** Run `end` on the stream once, and let a waiting write go on */
  const endStream = (end: () => void) => {
    if (!isStreamOpen) return;
    isStreamOpen = false;
    end();
    continueWriting();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) { controller = streamController; },
    pull: continueWriting,
    cancel() {
      endStream(() => {});
      stopDownload.abort();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_QUEUE_BYTES }));

  let markStarted = () => {};
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      markStarted();
      if (!isStreamOpen) {
        done();
        return;
      }
      controller.enqueue(chunk);
      if ((controller.desiredSize ?? 0) > 0) done();
      else finishWaitingWrite = done;
    },
  });

  const download = connector.downloadFile(filePath, output, stopDownload.signal);
  try {
    await Promise.race([started, download]);
  } catch (error) {
    output.destroy();
    throw error;
  }
  download.then(
    // Some writes can still wait in the output. The stream closes after the last of them.
    () => output.end(() => endStream(() => controller.close())),
    (error: Error) => endStream(() => controller.error(error)),
  );
  return stream;
}

/** Printable ASCII, but not the quote and the backslash, which would end the quoted name */
const NOT_SAFE_IN_QUOTES = /[^\x20-\x7e]|["\\]/g;

/**
 * The Content-Disposition header that downloads a file with this name.
 * "filename" is a plain ASCII copy for old browsers. "filename*" keeps every letter (RFC 6266 and RFC 5987).
 * A name with a line break or a letter outside Latin-1 would otherwise make the header invalid.
 */
export function attachmentHeader(fileName: string): string {
  const plainName = fileName.replace(NOT_SAFE_IN_QUOTES, '_');
  // encodeURIComponent leaves ' ( ) * as they are, but RFC 5987 does not allow them
  const encodedName = encodeURIComponent(fileName)
    .replace(/['()*]/g, mark => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plainName}"; filename*=UTF-8''${encodedName}`;
}
