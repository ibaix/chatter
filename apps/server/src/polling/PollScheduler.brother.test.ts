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
  MEM: "RLOD    MEM     00\r\nA01,'/       ',1001,0,0,0,0,0\r\n\r\n00%",
  ATCTL: 'RLOD    ATCTL   00\r\nM02,  1,0,0\r\nM03,  2,0,0\r\n\r\n00%',
  TOLNI1: "RLOD    TOLNI1  00\r\nT01, 1.5000, 0.0000, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n\r\n00%",
};

interface FakeBrother {
  server: net.Server;
  sockets: Set<net.Socket>;
  /** Each command that the fake got, in order */
  commands: string[];
}

/** The tool table and the tool data */
const TOOL_COMMANDS = ['ATCTL', 'TOLNI1'];

/**
 * A fake Brother. Each reply of the first connection takes `firstDelayMs`, and each reply of a later one `laterDelayMs`.
 * A reply to a tool command takes `toolDelayMs` when it is given.
 */
function startFakeBrother(firstDelayMs = SLOW_REPLY_MS, laterDelayMs = 0, toolDelayMs?: number): Promise<FakeBrother> {
  const sockets = new Set<net.Socket>();
  const commands: string[] = [];
  let connections = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const connectionDelayMs = ++connections === 1 ? firstDelayMs : laterDelayMs;
    // Like a real control, it answers one command at a time
    let replyQueue = Promise.resolve();
    socket.on('data', chunk => {
      const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
      commands.push(command);
      const reply = '%' + (REPLIES[command] ?? `RLOD    ${command.padEnd(8)}00\r\n\r\n00%`);
      const delayMs = toolDelayMs !== undefined && TOOL_COMMANDS.includes(command) ? toolDelayMs : connectionDelayMs;
      replyQueue = replyQueue
        .then(() => new Promise(resolve => setTimeout(resolve, delayMs)))
        .then(() => { if (!socket.destroyed) socket.write(reply); });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, commands })));
}

describe('a Brother poll that runs out of time in the scheduler', () => {
  let scheduler: PollScheduler | null = null;
  let fake: FakeBrother | null = null;
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

describe('a slow Brother in the scheduler', () => {
  /** The limits of a real Chatter, 10 times shorter: a 1 s poll limit, and 170 ms for each reply (1.7 s on a real machine) */
  const SCALED = { pollTimeoutMs: 1000, stuckPollMs: 6000, intervalMs: 20 };
  let scheduler: PollScheduler | null = null;
  let fake: FakeBrother | null = null;
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

  /** Poll the fake Brother with a real scheduler until `count` polls ended, and give the result of each poll */
  async function pollSlowBrother(replyDelayMs: number, count: number, toolDelayMs?: number) {
    fake = await startFakeBrother(replyDelayMs, replyDelayMs, toolDelayMs);
    const port = (fake.server.address() as net.AddressInfo).port;
    connector = new BrotherConnector({ id: 'speedio', name: 'Speedio', host: '127.0.0.1', dataPort: port, timeout: 900 });
    const results: { connected: boolean; errors: string[]; skipped: string[] }[] = [];
    scheduler = new PollScheduler({
      afterPoll: (machine: BaseMachineConnector) => {
        const { connected, errors, pollTimings } = machine.getStatus();
        results.push({ connected, errors: [...errors], skipped: pollTimings?.lastPoll.skipped ?? [] });
      },
      connectingEnded: () => {},
    }, SCALED);
    scheduler.setInterval(SCALED.intervalMs);

    scheduler.start(connector);
    await expect.poll(() => results.length, { timeout: count * 1500, interval: 20 }).toBeGreaterThanOrEqual(count);
    scheduler.stopAll();
    return results.slice(0, count);
  }

  it('stays online when each reply takes 17 % of the poll limit, and reads each command within a few polls', async () => {
    const results = await pollSlowBrother(170, 6, 0);

    expect(results.every(result => result.connected && result.errors.length === 0)).toBe(true);
    expect(results[0].skipped.length).toBeGreaterThan(0);
    expect(new Set(fake!.commands.filter(command => !TOOL_COMMANDS.includes(command))))
      .toEqual(new Set(['PANEL', 'MEM', 'ALARM', 'WKCNTR', 'PDSP']));
  }, 10_000);

  it('stays online while a tool read takes longer than the poll limit, and then shows the tool table', async () => {
    // The two tool replies take 1.4 s together, more than the 1 s poll limit
    const results = await pollSlowBrother(5, 60, 700);
    await connector!.toolSyncEnded();

    expect(results.every(result => result.connected && result.errors.length === 0)).toBe(true);
    expect(fake!.commands).toEqual(expect.arrayContaining(TOOL_COMMANDS));
    expect(connector!.getStatus().data.toolTable?.[1]).toMatchObject({ toolNum: 1, length: 1.5 });
  }, 10_000);

  it('skips nothing when the machine answers fast', async () => {
    const results = await pollSlowBrother(5, 4);

    expect(results.every(result => result.connected && result.skipped.length === 0)).toBe(true);
  });
});
