import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import { NETWORK_WAIT_MS, PollScheduler } from './PollScheduler.js';

const START = new Date('2026-11-12T10:00:00.000Z');
const CONNECTING_TIME_MS = 30_000;

/** A machine whose polls end when the test says so, with the errors of its last poll */
class FakeMachine {
  readonly id = 'machine_1';
  connected = true;
  polls = 0;
  disconnects = 0;
  errors: string[] = [];
  pollsWaitForTest = false;
  private endPoll: (() => void) | null = null;

  poll(): Promise<void> {
    this.polls++;
    if (!this.pollsWaitForTest) return Promise.resolve();
    return new Promise(resolve => { this.endPoll = resolve; });
  }

  disconnect(): void {
    this.disconnects++;
    this.connected = false;
  }

  getStatus() {
    return { errors: this.errors };
  }

  reportPollTimeout(): void {}

  endRunningPoll(): void {
    this.endPoll?.();
    this.endPoll = null;
  }

  asConnector(): BaseMachineConnector {
    return this as unknown as BaseMachineConnector;
  }
}

describe('PollScheduler health', () => {
  let machine: FakeMachine;
  let connectingEnded: Mock<(connector: BaseMachineConnector) => void>;
  let uptimeMs: number;
  let scheduler: PollScheduler;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    machine = new FakeMachine();
    connectingEnded = vi.fn();
    uptimeMs = 10 * 60_000;
    scheduler = new PollScheduler({ afterPoll: vi.fn(), connectingEnded }, { uptimeMs: () => uptimeMs + (Date.now() - START.getTime()) });
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  describe('pollClock', () => {
    it('is null for a machine that is not polled', () => {
      expect(scheduler.pollClock('machine_unknown')).toBeNull();
    });

    it('tells the start of the polling before the first poll ends, and the poll that runs', async () => {
      machine.pollsWaitForTest = true;
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.pollClock(machine.id)).toEqual({
        lastEndedAt: START.toISOString(), overdueAfterMs: 60_000, inProgressSince: START.toISOString(),
      });
    });

    it('tells the end of the last poll, good or bad', async () => {
      machine.connected = false;
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(2000);
      expect(scheduler.pollClock(machine.id)).toMatchObject({
        lastEndedAt: new Date(START.getTime() + 2000).toISOString(), inProgressSince: null,
      });
    });

    it('a stuck poll keeps the time of the last result, so the page can say "not polled for N min"', async () => {
      // A long stuck limit, so the scheduler does not leave this poll behind during the test
      scheduler = new PollScheduler({ afterPoll: vi.fn(), connectingEnded }, { stuckPollMs: 10 * 60_000 });
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(0);
      machine.pollsWaitForTest = true;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const clock = scheduler.pollClock(machine.id)!;
      expect(clock.lastEndedAt).toBe(new Date(START.getTime() + 2000 + 10_000).toISOString());
      expect(Date.now() - Date.parse(clock.lastEndedAt)).toBeGreaterThan(clock.overdueAfterMs);
      expect(clock.inProgressSince).toBe(new Date(START.getTime() + 2000).toISOString());
    });

    it('is overdue after 3 intervals, also when the machine fails and is polled less often', async () => {
      machine.connected = false;
      scheduler.start(machine.asConnector());
      while (machine.polls < 10) await vi.advanceTimersToNextTimerAsync();
      expect(scheduler.pollClock(machine.id)!.overdueAfterMs).toBe(3 * 60_000);
    });
  });

  describe('reconnect', () => {
    it('disconnects the machine and polls it now', async () => {
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(500);
      expect(scheduler.reconnect(machine.asConnector())).toBe('started');
      expect(machine.disconnects).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(machine.polls).toBe(2);
      // Only one chain of polls: the next poll comes one interval later
      await vi.advanceTimersByTimeAsync(2000);
      expect(machine.polls).toBe(3);
    });

    it('starts no second poll while a poll has not ended, and says so', async () => {
      machine.pollsWaitForTest = true;
      scheduler.start(machine.asConnector());
      // Longer than the poll timeout, shorter than the time after which the scheduler leaves a stuck poll behind
      await vi.advanceTimersByTimeAsync(30_000);
      expect(scheduler.reconnect(machine.asConnector())).toBe('poll-in-progress');
      await vi.advanceTimersByTimeAsync(0);
      expect(machine.polls).toBe(1);
      expect(machine.disconnects).toBeGreaterThan(0);
    });

    it('does nothing to a machine that is not polled', () => {
      expect(scheduler.reconnect(machine.asConnector())).toBe('not-polled');
      expect(machine.polls).toBe(0);
    });
  });

  describe('the network after a start of the Pi', () => {
    it('keeps an unreachable machine connecting until the server has run 2 minutes', async () => {
      uptimeMs = 5000;
      machine.connected = false;
      machine.errors = ['Unable to connect: connect EHOSTUNREACH 192.168.1.50:10000'];
      scheduler.start(machine.asConnector());

      await vi.advanceTimersByTimeAsync(CONNECTING_TIME_MS);
      expect(scheduler.isConnecting(machine.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(NETWORK_WAIT_MS - 5000 - CONNECTING_TIME_MS - 1);
      expect(scheduler.isConnecting(machine.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(scheduler.isConnecting(machine.id)).toBe(false);
      expect(connectingEnded).toHaveBeenCalledTimes(1);
    });

    it('does not wait for a machine that refuses the connection: the network is there', async () => {
      uptimeMs = 5000;
      machine.connected = false;
      machine.errors = ['Unable to connect: connect ECONNREFUSED 192.168.1.50:10000'];
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(CONNECTING_TIME_MS);
      expect(scheduler.isConnecting(machine.id)).toBe(false);
    });

    it('does not wait when the server has run long enough', async () => {
      machine.connected = false;
      machine.errors = ['connect EHOSTUNREACH 192.168.1.50:10000'];
      scheduler.start(machine.asConnector());
      await vi.advanceTimersByTimeAsync(CONNECTING_TIME_MS);
      expect(scheduler.isConnecting(machine.id)).toBe(false);
    });
  });
});
