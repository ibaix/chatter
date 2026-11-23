import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { attachmentHeader, downloadAsStream } from './fileDownload.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';

/** A connector whose download runs the given steps on the output stream */
function connectorThat(download: (output: Writable) => Promise<void>): BaseMachineConnector {
  return { downloadFile: (_path: string, output: Writable) => download(output) } as BaseMachineConnector;
}

async function readAll(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

const nextTick = () => new Promise(resolve => setImmediate(resolve));

describe('downloadAsStream', () => {
  it('gives the file content', async () => {
    const connector = connectorThat(async output => {
      output.write('G00 ');
      await nextTick();
      output.write('X0');
    });

    expect(await readAll(await downloadAsStream(connector, '/O0100.NC'))).toBe('G00 X0');
  });

  it('gives an empty stream for an empty file', async () => {
    const connector = connectorThat(async () => {});

    expect(await readAll(await downloadAsStream(connector, '/EMPTY.NC'))).toBe('');
  });

  it('fails when the download fails before the first bytes', async () => {
    const connector = connectorThat(async () => {
      throw new Error('FTP download error: 550 No such file');
    });

    await expect(downloadAsStream(connector, '/MISSING.NC')).rejects.toThrow('550');
  });

  it('stops the stream when the download fails after the first bytes', async () => {
    const connector = connectorThat(async output => {
      output.write('G00');
      await nextTick();
      throw new Error('connection lost');
    });

    const stream = await downloadAsStream(connector, '/O0100.NC');

    await expect(readAll(stream)).rejects.toThrow();
  });

  it('keeps the server running when the reader stops early', async () => {
    let writesAfterCancel = 0;
    const connector = connectorThat(async output => {
      output.write('G00');
      await nextTick();
      await nextTick();
      output.write('X0');
      writesAfterCancel++;
    });

    const stream = await downloadAsStream(connector, '/O0100.NC');
    await stream.cancel();
    await nextTick();
    await nextTick();
    await nextTick();

    expect(writesAfterCancel).toBe(1);
  });

  // A slow browser must slow the machine download. Else the whole file waits in the memory of a Pi.
  describe('with a reader that is slow', () => {
    const chunk = Buffer.alloc(8 * 1024, 'G');
    const chunkCount = 128;

    /** A connector that writes 1 MB and waits for 'drain' when the output is full, as the FTP download does */
    function bigFileConnector() {
      const state = { writtenBytes: 0, done: Promise.resolve() };
      const connector = connectorThat(output => {
        state.done = (async () => {
          for (let index = 0; index < chunkCount; index += 1) {
            state.writtenBytes += chunk.length;
            if (!output.write(chunk)) await once(output, 'drain');
          }
        })();
        return state.done;
      });
      return { connector, state };
    }

    it('takes no more data while nobody reads the stream', async () => {
      const { connector, state } = bigFileConnector();

      const stream = await downloadAsStream(connector, '/BIG.NC');
      for (let turn = 0; turn < 20; turn += 1) await nextTick();

      expect(state.writtenBytes).toBeLessThan(256 * 1024);
      expect((await readAll(stream)).length).toBe(chunk.length * chunkCount);
    });

    it('lets the download run to its end when the reader stops', async () => {
      const { connector, state } = bigFileConnector();

      const stream = await downloadAsStream(connector, '/BIG.NC');
      await nextTick();
      await stream.cancel();
      await state.done;

      expect(state.writtenBytes).toBe(chunk.length * chunkCount);
    });
  });
});

describe('attachmentHeader', () => {
  it('gives the name two times: plain for old browsers, and encoded for new browsers', () => {
    expect(attachmentHeader('O1000.NC')).toBe(`attachment; filename="O1000.NC"; filename*=UTF-8''O1000.NC`);
  });

  it('changes quotes and backslashes in the plain name, so they cannot end it early', () => {
    expect(attachmentHeader('a"b\\c.nc')).toBe(`attachment; filename="a_b_c.nc"; filename*=UTF-8''a%22b%5Cc.nc`);
  });

  it('keeps letters outside ASCII in the encoded name', () => {
    expect(attachmentHeader('Teil-ü.nc')).toBe(`attachment; filename="Teil-_.nc"; filename*=UTF-8''Teil-%C3%BC.nc`);
  });

  it('encodes the marks that encodeURIComponent leaves', () => {
    expect(attachmentHeader("it's (1)*.nc")).toBe(`attachment; filename="it's (1)*.nc"; filename*=UTF-8''it%27s%20%281%29%2A.nc`);
  });

  it('removes line breaks, so the name cannot add a header', () => {
    expect(attachmentHeader('a\r\nSet-Cookie: x')).toBe(`attachment; filename="a__Set-Cookie: x"; filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x`);
  });
});
