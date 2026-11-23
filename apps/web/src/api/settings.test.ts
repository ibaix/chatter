import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlockUser } from './settings';

function replyWith(status: number, body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': 'application/json' } })));
}

describe('unlockUser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the username to the unlock route', async () => {
    replyWith(200, JSON.stringify({ limits: {}, locked: [], lockedUsers: [], tries: [] }));

    await unlockUser('admin');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/settings/logins/unlock');
    expect(JSON.parse(String(init.body))).toEqual({ username: 'admin' });
  });

  it('gives the reason of the server when the unlock fails', async () => {
    replyWith(400, JSON.stringify({ error: 'Give an address or a username to unlock' }));
    await expect(unlockUser('admin')).rejects.toThrow('Give an address or a username to unlock');
  });

  it('names the user when the reply has no reason', async () => {
    replyWith(502, '<html>Bad gateway</html>');
    await expect(unlockUser('admin')).rejects.toThrow('Could not unlock the user admin');
  });
});
