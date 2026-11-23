import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveMachineUpdate } from './machines';

function replyWith(status: number, body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': 'application/json' } })));
}

describe('saveMachineUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the change to the route of the machine', async () => {
    replyWith(200, JSON.stringify({ id: 'm1' }));

    await saveMachineUpdate('m1', { host: '192.168.1.99' });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/machine/m1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ host: '192.168.1.99' });
  });

  // The App shows this text. It tells the user to type the saved password again.
  it('gives the reason of the server when the save fails', async () => {
    const reason = 'Type the FTP password again. You changed the IP address or a port.';
    replyWith(400, JSON.stringify({ error: reason }));

    await expect(saveMachineUpdate('m1', { host: '192.168.1.99' })).rejects.toThrow(reason);
  });

  it('gives a general text when the reply has no reason', async () => {
    replyWith(502, '<html>Bad gateway</html>');

    await expect(saveMachineUpdate('m1', { host: '192.168.1.99' })).rejects.toThrow('Could not save the machine settings');
  });
});
