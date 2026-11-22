import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { webStreamOf } from './webStream.js';

describe('webStreamOf', () => {
  it('gives each part, then calls onDone once at the end', async () => {
    const onDone = vi.fn();
    const stream = webStreamOf(Readable.from([Buffer.from('ab'), Buffer.from('c')]), onDone);
    expect(await new Response(stream).text()).toBe('abc');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it('stops the source and calls onDone when the browser stops early', async () => {
    const onDone = vi.fn();
    const source = Readable.from((function* () {
      for (;;) yield Buffer.from('x');
    })());
    const reader = webStreamOf(source, onDone).getReader();
    await reader.read();
    await reader.cancel();
    expect(source.destroyed).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(false);
  });

  it('calls onDone when the source fails', async () => {
    const onDone = vi.fn();
    const source = new Readable({ read() {
      this.destroy(new Error('disk failed'));
    } });
    await expect(new Response(webStreamOf(source, onDone)).text()).rejects.toThrow('disk failed');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(false);
  });
});
