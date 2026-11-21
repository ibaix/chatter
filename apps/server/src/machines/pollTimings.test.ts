import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { PollTimingRecorder, TIMING_SAMPLES, WARN_EVERY_MS } from './pollTimings.js';

const LIMIT_MS = 10000;

/** A clock that the test moves */
function testClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return { now: () => time, advance: ms => { time += ms; } };
}

/** One poll that sends each command, each taking its time on the test clock */
async function poll(recorder: PollTimingRecorder, clock: ReturnType<typeof testClock>, commands: Record<string, number>): Promise<void> {
  recorder.startPoll();
  for (const [command, ms] of Object.entries(commands)) {
    await recorder.time(command, async () => { clock.advance(ms); });
  }
  recorder.endPoll(LIMIT_MS);
}

describe('PollTimingRecorder', () => {
  let log: CapturedLog;
  let clock: ReturnType<typeof testClock>;
  let recorder: PollTimingRecorder;

  beforeEach(() => {
    log = captureLog();
    clock = testClock();
    recorder = new PollTimingRecorder('speedio', clock.now);
  });

  afterEach(() => log.restore());

  it('has no timings before the first poll', () => {
    expect(recorder.snapshot()).toBeUndefined();
  });

  it('gives the last, average and maximum time of each command and of the whole poll', async () => {
    await poll(recorder, clock, { PANEL: 100, MEM: 300 });
    await poll(recorder, clock, { PANEL: 200, MEM: 100 });

    const timings = recorder.snapshot()!;

    expect(timings.limitMs).toBe(LIMIT_MS);
    expect(timings.commands.PANEL).toEqual({ lastMs: 200, avgMs: 150, maxMs: 200, samples: 2 });
    expect(timings.commands.MEM).toEqual({ lastMs: 100, avgMs: 200, maxMs: 300, samples: 2 });
    expect(timings.poll).toEqual({ lastMs: 300, avgMs: 350, maxMs: 400, samples: 2 });
    expect(timings.lastPoll.commands).toEqual({ PANEL: 200, MEM: 100 });
    expect(timings.lastPoll.totalMs).toBe(300);
  });

  it('keeps only the last samples, so the memory stays the same however long Chatter runs', async () => {
    await poll(recorder, clock, { PANEL: 5000 });
    for (let i = 0; i < TIMING_SAMPLES; i++) await poll(recorder, clock, { PANEL: 10 });

    expect(recorder.snapshot()!.commands.PANEL).toEqual({ lastMs: 10, avgMs: 10, maxMs: 10, samples: TIMING_SAMPLES });
  });

  it('records the time of a command that fails', async () => {
    recorder.startPoll();
    const failing = recorder.time('PANEL', async () => { clock.advance(250); throw new Error('closed'); });

    await expect(failing).rejects.toThrow('closed');
    recorder.endPoll(LIMIT_MS);
    expect(recorder.snapshot()!.commands.PANEL.lastMs).toBe(250);
  });

  it('starts each poll with no skipped command', async () => {
    recorder.startPoll();
    recorder.skip('ATCTL');
    recorder.skip('MCRNI1');
    recorder.endPoll(LIMIT_MS);
    await poll(recorder, clock, { PANEL: 10 });

    expect(recorder.snapshot()!.lastPoll.skipped).toEqual([]);
  });

  it('gives the skipped commands of the poll that skipped them', () => {
    recorder.startPoll();
    recorder.skip('ATCTL');
    recorder.endPoll(LIMIT_MS);

    expect(recorder.snapshot()!.lastPoll.skipped).toEqual(['ATCTL']);
  });

  it('gives the time since the poll started', () => {
    recorder.startPoll();
    clock.advance(1234);

    expect(recorder.elapsedMs()).toBe(1234);
  });

  it('estimates a command from its last and average time, the longer of the two', async () => {
    await poll(recorder, clock, { PANEL: 300 });
    await poll(recorder, clock, { PANEL: 100 });

    expect(recorder.estimateMs('PANEL')).toBe(200);
    expect(recorder.estimateMs('MEM')).toBeUndefined();
  });

  it('gives the time of the slowest command of this poll so far, and 0 before the first command', async () => {
    recorder.startPoll();
    expect(recorder.slowestInPollMs()).toBe(0);

    await recorder.time('PANEL', async () => { clock.advance(300); });
    await recorder.time('MEM', async () => { clock.advance(100); });

    expect(recorder.slowestInPollMs()).toBe(300);
  });

  it('writes the times of each poll at debug level', async () => {
    await poll(recorder, clock, { PANEL: 120, MEM: 80 });

    expect(log.text('debug')).toMatch(/Poll times.*machine=speedio.*totalMs=200/);
    expect(log.text('debug')).toContain('PANEL=120');
  });

  it('warns when a poll uses more than 60 % of its limit, with the slowest commands', async () => {
    await poll(recorder, clock, { PANEL: 500, MEM: 4000, PDSP: 2000 });

    const warning = log.text('warn');
    expect(warning).toMatch(/machine=speedio/);
    expect(warning).toMatch(/totalMs=6500/);
    expect(warning).toContain('MEM 4000 ms, PDSP 2000 ms, PANEL 500 ms');
  });

  it('does not warn for a poll that uses 60 % of its limit or less', async () => {
    await poll(recorder, clock, { PANEL: 3000, MEM: 3000 });

    expect(log.text('warn')).toBe('');
  });

  it('warns at most once in 10 minutes for each machine', async () => {
    await poll(recorder, clock, { MEM: 7000 });
    clock.advance(WARN_EVERY_MS - 60_000);
    await poll(recorder, clock, { MEM: 7000 });
    expect(log.lines.filter(line => line.level === 'warn')).toHaveLength(1);

    clock.advance(60_000);
    await poll(recorder, clock, { MEM: 7000 });

    expect(log.lines.filter(line => line.level === 'warn')).toHaveLength(2);
    expect(WARN_EVERY_MS).toBe(10 * 60_000);
  });

  it('warns for each machine on its own', async () => {
    const other = new PollTimingRecorder('robodrill', clock.now);

    await poll(recorder, clock, { MEM: 7000 });
    await poll(other, clock, { MEM: 7000 });

    expect(log.text('warn')).toMatch(/machine=speedio[\s\S]*machine=robodrill/);
  });
});
