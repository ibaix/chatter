import { describe, expect, it, vi } from 'vitest';
import { StreamsPerLogin } from './StreamsPerLogin.js';

describe('StreamsPerLogin', () => {
  it('closes the oldest stream of a login when the login has more than the limit', () => {
    const streams = new StreamsPerLogin(2);
    const closes = [vi.fn(), vi.fn(), vi.fn()];

    for (const close of closes) streams.add('admin', close);

    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).not.toHaveBeenCalled();
  });

  it('keeps the limit when a closed stream ends after it was removed', () => {
    const streams = new StreamsPerLogin(2);
    const closes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const release = streams.add('admin', closes[0]);
    streams.add('admin', closes[1]);
    streams.add('admin', closes[2]);
    // The closed stream ends a moment later, and frees its slot again
    release();

    streams.add('admin', closes[3]);

    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(closes[2]).not.toHaveBeenCalled();
    expect(closes[3]).not.toHaveBeenCalled();
  });

  it('forgets a login when its last stream ends', () => {
    const streams = new StreamsPerLogin(2);
    const first = streams.add('admin', vi.fn());
    const second = streams.add('admin', vi.fn());
    streams.add('operator', vi.fn());

    first();
    expect(streams.size).toBe(2);
    second();

    expect(streams.size).toBe(1);
  });
});
