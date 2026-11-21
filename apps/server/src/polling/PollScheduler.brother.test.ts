import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { BrotherConnector } from '../machines/brother/BrotherConnector.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import { PollScheduler } from './PollScheduler.js';

/**
 * A real Brother connector, a real scheduler and a fake Brother on a TCP port, with short time limits.
 * On a Pi, a poll that ran out of time left the machine offline, with no reason, until Chatter restarted.
 */

/** Short limits, so the test takes about one second. The poll limit is shorter than one slow poll. */
const LIMITS = { pollTimeoutMs: 300, stuckPollMs: 3000, intervalMs: 50 };
const COMMAND_TIMEOUT_MS = 250;
/** Each reply of a slow connection takes this long. A poll sends about 8 commands, so it takes longer than the poll limit. */
const SLOW_REPLY_MS = 100;

/** A reply with the values that a poll reads */
const REPLIES: Record<string, string> = {
  PANEL: 'RLOD    PANEL   00\r\nK01,0,5,0,0,0,0,0,0,0,1,0\r\n\r\n10%',
  WKCNTR: 'RLOD    WKCNTR  00\r\nA01,  1,    78,   200,     0\r\n\r\n08%',
};

/** A fake Brother. The first connection answers slowly, each later one at once. */
function startFakeBrother(): Promise<{ server: net.Server; sockets: Set<net.Socket> }> {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const delayMs = ++connections === 1 ? SLOW_REPLY_MS : 0;
    socket.on('data', chunk => {
      const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
      const reply = '%' + (REPLIES[command] ?? `RLOD    ${command.padEnd(8)}00\r\n\r\n00%`);
      setTimeout(() => { if (!socket.destroyed) socket.write(reply); }, delayMs);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, sockets })));
}

describe('a Brother poll that runs out of time in the scheduler', () => {
  let scheduler: PollScheduler | null = null;
  let fake: { server: net.Server; sockets: Set<net.Socket> } | null = null;
  let connector: BrotherConnector | null = null;

  afterEach(async () => {
    scheduler?.stopAll();
    connector?.disconnect();
    if (fake) {
      for (const socket of fake.sockets) socket.destroy();
      await new Promise(resolve => fake!.server.close(resolve));
    }
    scheduler = null;
    fake = null;
    connector = null;
  });

  it('gives a reason, ends the poll, and connects again, so the machine comes back', async () => {
    fake = await startFakeBrother();
    const port = (fake.server.address() as net.AddressInfo).port;
    connector = new BrotherConnector({ id: 'speedio', name: 'Speedio', host: '127.0.0.1', dataPort: port, timeout: COMMAND_TIMEOUT_MS });
    const results: { connected: boolean; errors: string[] }[] = [];
    scheduler = new PollScheduler({
      afterPoll: (machine: BaseMachineConnector) => {
        const { connected, errors } = machine.getStatus();
        results.push({ connected, errors: [...errors] });
      },
      connectingEnded: () => {},
    }, LIMITS);
    scheduler.setInterval(LIMITS.intervalMs);

    scheduler.start(connector);

    await expect.poll(() => results.some(result => result.connected), { timeout: 2500, interval: 20 }).toBe(true);
    expect(results[0].connected).toBe(false);
    expect(results[0].errors.join('; ')).toContain('did not answer all requests');
    expect(results.at(-1)?.errors).toEqual([]);
  });
});
