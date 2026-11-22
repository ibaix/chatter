import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import { captureLog } from '../logging/testSupport.js';
import { PollScheduler } from './PollScheduler.js';

const POLL_TIMEOUT_MS = 10000;
/** After this time, the scheduler stops waiting for a poll that does not end */
const STUCK_POLL_MS = 60000;

/** A machine whose polls end when the test says so */
class FakeMachine {
  readonly id = 'machine_1';
  connected = true;
  polls = 0;
  /** The polls that wait for the test, the oldest first */
  private readonly waitingPolls: (() => void)[] = [];
  /** The time limits that the scheduler told the machine about */
  readonly timeoutReports: number[] = [];

  /** Each poll waits until endRunningPoll() is called */
  pollsWaitForTest = false;
  /** How a poll fails, if it fails */
  failure: 'none' | 'rejects' | 'throws at once' = 'none';

  poll(): Promise<void> {
    this.polls++;
    if (this.failure === 'throws at once') throw new Error('Bad connector');
    if (this.failure === 'rejects') return Promise.reject(new Error('No answer'));
    if (!this.pollsWaitForTest) return Promise.resolve();
    return new Promise(resolve => { this.waitingPolls.push(resolve); });
  }

  disconnects = 0;

  disconnect(): void {
    this.disconnects++;
    this.connected = false;
  }

  /** End the oldest poll that waits */
  endRunningPoll(): void {
    this.waitingPolls.shift()?.();
  }

  reportPollTimeout(timeoutMs: number): void {
    this.timeoutReports.push(timeoutMs);
  }

  asConnector(): BaseMachineConnector {
    return this as unknown as BaseMachineConnector;
  }
}

describe('PollScheduler', () => {
  let machine: FakeMachine;
  let afterPoll: Mock<(connector: BaseMachineConnector) => void>;
  let connectingEnded: Mock<(connector: BaseMachineConnector) => void>;
  let scheduler: PollScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    machine = new FakeMachine();
    afterPoll = vi.fn();
    connectingEnded = vi.fn();
    scheduler = new PollScheduler({ afterPoll, connectingEnded });
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  /** Fail the first polls, so the machine has this many failures */
  async function failPolls(count: number) {
    machine.connected = false;
    scheduler.start(machine.asConnector());
    // Timer by timer, because the timer that ends the connecting time comes between the polls
    while (machine.polls < count) await vi.advanceTimersToNextTimerAsync();
  }

  describe('the time between polls', () => {
    it('is the interval that was set, when the machine does not fail', async () => {
      scheduler.setInterval(5000);
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(4999);
      expect(machine.polls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(machine.polls).toBe(2);
    });

    it('becomes 10 seconds after 3 failures in a row', async () => {
      await failPolls(3);

      await vi.advanceTimersByTimeAsync(9999);
      expect(machine.polls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(machine.polls).toBe(4);
    });

    it.each([
      { failures: 6, interval: 30000 },
      { failures: 10, interval: 60000 },
    ])('becomes $interval ms after $failures failures in a row', async ({ failures, interval }) => {
      await failPolls(failures);

      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(machine.polls).toBe(failures);
      await vi.advanceTimersByTimeAsync(1);
      expect(machine.polls).toBe(failures + 1);
    });

    it('goes back to the interval that was set after a good poll', async () => {
      await failPolls(3);
      machine.connected = true;
      await vi.advanceTimersToNextTimerAsync();

      await vi.advanceTimersByTimeAsync(2000);
      expect(machine.polls).toBe(5);
    });

    it('is never shorter than the interval that was set', async () => {
      scheduler.setInterval(20000);
      await failPolls(3);

      await vi.advanceTimersByTimeAsync(19999);
      expect(machine.polls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(machine.polls).toBe(4);
    });
  });

  it('stops the timeout timer when a poll ends in time', async () => {
    scheduler.start(machine.asConnector());
    await vi.advanceTimersByTimeAsync(0);

    // Only the timer for the next poll is left
    expect(vi.getTimerCount()).toBe(1);
    // A poll that ends in time does not disconnect
    expect(machine.disconnects).toBe(0);
  });

  it('tells the machine its poll time limit before the first poll, so the machine can report its poll times against it', async () => {
    const shortLimit = new PollScheduler({ afterPoll, connectingEnded }, { pollTimeoutMs: 4000 });
    const limits: number[] = [];
    vi.spyOn(machine, 'poll').mockImplementation(() => {
      limits.push((machine as unknown as { pollTimeLimitMs: number }).pollTimeLimitMs);
      return Promise.resolve();
    });

    shortLimit.start(machine.asConnector());
    await vi.advanceTimersByTimeAsync(0);

    expect(limits).toEqual([4000]);
    shortLimit.stopAll();
  });

  describe('a poll that runs out of time', () => {
    beforeEach(async () => {
      machine.pollsWaitForTest = true;
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    });

    it('counts as a failure at once', () => {
      expect(afterPoll).toHaveBeenCalledTimes(1);
    });

    it('disconnects the machine, so its old values do not show as live', () => {
      expect(machine.disconnects).toBe(1);
      expect(machine.connected).toBe(false);
    });

    it('disconnects again when the late poll ends, so what it did does not count', async () => {
      // For example a connect that ended after all
      machine.connected = true;
      machine.endRunningPoll();
      await vi.advanceTimersByTimeAsync(0);

      expect(machine.disconnects).toBe(2);
      expect(machine.connected).toBe(false);
    });

    it('is not polled over again while it still runs', async () => {
      // Until the scheduler stops waiting for it (see "a poll that never ends")
      await vi.advanceTimersByTimeAsync(STUCK_POLL_MS - POLL_TIMEOUT_MS - 1);

      expect(machine.polls).toBe(1);
    });

    it('tells the machine why it is offline, so the status and the log have a reason', () => {
      expect(machine.timeoutReports).toEqual([POLL_TIMEOUT_MS]);
    });

    it('lets the next poll start after it ends', async () => {
      machine.endRunningPoll();
      await vi.runOnlyPendingTimersAsync();

      expect(machine.polls).toBe(2);
    });
  });

  describe('a poll that never ends', () => {
    beforeEach(async () => {
      machine.pollsWaitForTest = true;
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);
    });

    it('stops blocking the machine after 60 seconds, so the next poll runs and connects again', async () => {
      const log = captureLog();
      try {
        // The next poll comes at the next timer, after the interval
        await vi.advanceTimersByTimeAsync(STUCK_POLL_MS + 2000);

        expect(machine.polls).toBe(2);
        expect(log.text('warn')).toContain('A poll did not end');
      } finally {
        log.restore();
      }
    });

    it('disconnects the machine when it stops waiting, also when the old poll connected after the timeout', async () => {
      await vi.advanceTimersByTimeAsync(STUCK_POLL_MS - 1);
      // For example a connect of the old poll that ended after all
      machine.connected = true;
      const disconnectsBefore = machine.disconnects;

      await vi.advanceTimersByTimeAsync(1);

      expect(machine.disconnects).toBe(disconnectsBefore + 1);
      expect(machine.connected).toBe(false);
    });

    it('does not let the late end of the old poll free or disconnect the new poll', async () => {
      // The next poll comes at the next timer, after the interval
      await vi.advanceTimersByTimeAsync(STUCK_POLL_MS + 2000);
      expect(machine.polls).toBe(2);
      machine.connected = true;
      const disconnectsBefore = machine.disconnects;

      // The old poll ends at last, while the new one still runs
      machine.endRunningPoll();
      await vi.advanceTimersByTimeAsync(0);

      expect(machine.disconnects).toBe(disconnectsBefore);
      await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS * 2);
      // The new poll still runs, so no third poll starts over it
      expect(machine.polls).toBe(2);
    });
  });

  it.each(['rejects', 'throws at once'] as const)('counts a poll that %s as a failure, and keeps polling', async failure => {
    machine.failure = failure;
    await failPolls(3);

    // 3 failures: the next poll is in 10 seconds
    await vi.advanceTimersByTimeAsync(10000);
    expect(machine.polls).toBe(4);
  });

  it('sets no new timer and calls no hook when a poll ends after the scheduler stopped', async () => {
    machine.pollsWaitForTest = true;
    scheduler.start(machine.asConnector());
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stopAll();
    machine.endRunningPoll();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(afterPoll).not.toHaveBeenCalled();
  });

  it('polls a stopped machine one time with pollNow, and sets no timer', async () => {
    await scheduler.pollNow(machine.asConnector());

    expect(machine.polls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls only one chain after a stop and a start during a poll', async () => {
    machine.pollsWaitForTest = true;
    scheduler.start(machine.asConnector());
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stop(machine.id);
    scheduler.start(machine.asConnector());
    machine.pollsWaitForTest = false;
    machine.endRunningPoll();
    await vi.advanceTimersByTimeAsync(2000);

    expect(machine.polls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  describe('connecting', () => {
    const CONNECTING_TIME_MS = 30000;

    it('says a new machine is connecting until its first good poll', async () => {
      machine.pollsWaitForTest = true;
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.isConnecting(machine.id)).toBe(true);

      machine.endRunningPoll();
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.isConnecting(machine.id)).toBe(false);
      expect(connectingEnded).not.toHaveBeenCalled();
    });

    it('is already done connecting when afterPoll tells about the first good poll', async () => {
      let wasConnecting: boolean | undefined;
      afterPoll.mockImplementation(() => { wasConnecting = scheduler.isConnecting(machine.id); });
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);

      expect(wasConnecting).toBe(false);
    });

    it('keeps connecting through failed polls, and stops after 30 seconds with no good poll', async () => {
      machine.connected = false;
      scheduler.start(machine.asConnector());

      await vi.advanceTimersByTimeAsync(CONNECTING_TIME_MS - 1);
      expect(scheduler.isConnecting(machine.id)).toBe(true);
      expect(connectingEnded).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(scheduler.isConnecting(machine.id)).toBe(false);
      expect(connectingEnded).toHaveBeenCalledTimes(1);
      expect(connectingEnded).toHaveBeenCalledWith(machine.asConnector());
    });

    it('is not connecting after a stop, and does not call connectingEnded later', async () => {
      machine.connected = false;
      scheduler.start(machine.asConnector());

      scheduler.stop(machine.id);
      await vi.advanceTimersByTimeAsync(CONNECTING_TIME_MS);

      expect(scheduler.isConnecting(machine.id)).toBe(false);
      expect(connectingEnded).not.toHaveBeenCalled();
    });

    it('connects again for 30 seconds when a machine starts again', async () => {
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop(machine.id);

      machine.connected = false;
      scheduler.start(machine.asConnector());

      expect(scheduler.isConnecting(machine.id)).toBe(true);
    });

    it('says a machine that is not polled is not connecting', () => {
      expect(scheduler.isConnecting('machine_unknown')).toBe(false);
    });
  });
});
