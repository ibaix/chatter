import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStateTimeline } from './stateTimeline';

function replyWith(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

describe('fetchStateTimeline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the range, and gives the times in milliseconds with the alarm text and program only when there are some', async () => {
    replyWith(200, {
      data: [
        { state: 'offline', start: '2026-11-19T10:00:00.000Z', end: '2026-11-19T10:05:00.000Z' },
        { state: 'alarm', start: '2026-11-19T10:05:00.000Z', end: '2026-11-19T10:06:00.000Z', detail: '1001 DOOR OPEN', program: 'O1' },
      ],
    });

    const segments = await fetchStateTimeline('m1', '-1h');

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/machine/m1/state-timeline?range=-1h');
    expect(segments).toEqual([
      { state: 'offline', start: Date.UTC(2026, 10, 19, 10, 0), end: Date.UTC(2026, 10, 19, 10, 5) },
      { state: 'alarm', start: Date.UTC(2026, 10, 19, 10, 5), end: Date.UTC(2026, 10, 19, 10, 6), detail: '1001 DOOR OPEN', program: 'O1' },
    ]);
  });

  it('throws when the server does not give the timeline', async () => {
    replyWith(503, { error: 'not available' });

    await expect(fetchStateTimeline('m1', '-1h')).rejects.toThrow('Could not load the machine state history');
  });
});
