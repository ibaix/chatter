import type { PollClock } from '@local-chatter/shared';
import { createLogger } from '../logging/logger.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';

const log = createLogger('poller');

interface PollSchedulerHooks {
  /** Called after each poll of a machine, good or bad */
  afterPoll(connector: BaseMachineConnector): void;
  /** Called when a machine had no good poll in its connecting time, so it is offline now */
  connectingEnded(connector: BaseMachineConnector): void;
}

/** A connector in a bad state may throw on disconnect. It counts as disconnected all the same. */
function disconnectQuietly(connector: BaseMachineConnector): void {
  try {
    connector.disconnect();
  } catch {
    connector.connected = false;
  }
}

const DEFAULT_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10000;
/**
 * The first poll of a real machine can take 5 to 15 seconds. Until the first good poll,
 * and for at most this time, the machine is "connecting", not "offline".
 */
const CONNECTING_TIME_MS = 30000;
/**
 * A poll that still has not ended this long after it started is stuck: a promise in the connector that never settles.
 * Then the scheduler stops waiting for it, so one bug cannot keep a machine offline until Chatter restarts.
 * Each connector ends its requests on a timeout or a closed socket, so a working poll is never this slow.
 */
const STUCK_POLL_MS = 60000;
/**
 * After a start of the Pi, the network can need some time. Until the server has run this long,
 * a machine that is "unreachable" (no route to it yet) stays connecting, so the log does not call it offline.
 */
export const NETWORK_WAIT_MS = 2 * 60_000;
/** The errors of a network that is not ready yet: no route, no network, or no DNS answer yet */
const NETWORK_NOT_READY = /EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN/;
/** "Not polled for N min" shows after this many intervals with no poll result, and never before this time */
const OVERDUE_INTERVALS = 3;
const MIN_OVERDUE_MS = 60_000;

/** What a reconnect did: a new poll started, or a poll that has not ended stops a new one, or the machine is not polled */
export type ReconnectResult = 'started' | 'poll-in-progress' | 'not-polled';

/**
 * A machine that fails often is polled less often, so it does not slow the server.
 * The time is never shorter than the interval that was set.
 */
const BACKOFF_STEPS = [
  { minFailures: 3, intervalMs: 10000 },   // 3-5 failures: 10 seconds
  { minFailures: 6, intervalMs: 30000 },   // 6-9 failures: 30 seconds
  { minFailures: 10, intervalMs: 60000 },  // 10+ failures: 60 seconds
];

/** The last poll failed because the network of this computer is not ready yet, for example just after a start of the Pi */
function isNetworkNotReady(connector: BaseMachineConnector): boolean {
  try {
    return connector.getStatus().errors.some(error => NETWORK_NOT_READY.test(error));
  } catch {
    // A connector in a bad state counts as a machine that cannot be reached
    return false;
  }
}

/**
 * Polls each machine on its own timer, so a slow machine does not hold up the others.
 * Only one poll runs at a time for each machine, also when a poll runs out of time.
 */
export class PollScheduler {
  private baseIntervalMs = DEFAULT_INTERVAL_MS;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The machines to keep polling: from start() until stop() */
  private readonly activeIds = new Set<string>();
  /** The machines with a poll that has not ended yet, each with a token for that poll */
  private readonly pollsInProgress = new Map<string, symbol>();
  private readonly failureCounts = new Map<string, number>();
  /** The machines that are connecting, each with the timer that ends its connecting time */
  private readonly connectingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** When the polling of each machine started, and when its last poll ended */
  private readonly startTimes = new Map<string, number>();
  private readonly endTimes = new Map<string, number>();
  private readonly pollStartTimes = new Map<string, number>();

  private readonly pollTimeoutMs: number;
  private readonly stuckPollMs: number;
  /** How long the server has run */
  private readonly uptimeMs: () => number;

  /** `limits` is for tests, which need short times and their own uptime */
  constructor(
    private readonly hooks: PollSchedulerHooks,
    limits: { pollTimeoutMs?: number; stuckPollMs?: number; uptimeMs?: () => number } = {},
  ) {
    this.pollTimeoutMs = limits.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.stuckPollMs = limits.stuckPollMs ?? STUCK_POLL_MS;
    this.uptimeMs = limits.uptimeMs ?? (() => process.uptime() * 1000);
  }

  /** The poll times of a machine that is polled, else null */
  pollClock(id: string): PollClock | null {
    const startedAt = this.startTimes.get(id);
    if (startedAt === undefined) return null;
    const inProgressSince = this.pollStartTimes.get(id);
    return {
      lastEndedAt: new Date(this.endTimes.get(id) ?? startedAt).toISOString(),
      overdueAfterMs: Math.max(OVERDUE_INTERVALS * this.nextIntervalMs(id), MIN_OVERDUE_MS),
      inProgressSince: inProgressSince === undefined ? null : new Date(inProgressSince).toISOString(),
    };
  }

  /**
   * Disconnect the machine and poll it now, as after a start. A poll that has not ended yet
   * (for example a machine that never answers) stops a second poll: two polls at once would talk over each other.
   */
  reconnect(connector: BaseMachineConnector): ReconnectResult {
    if (!this.activeIds.has(connector.id)) return 'not-polled';
    disconnectQuietly(connector);
    if (this.pollsInProgress.has(connector.id)) return 'poll-in-progress';
    clearTimeout(this.timers.get(connector.id));
    this.failureCounts.set(connector.id, 0);
    void this.pollNow(connector);
    return 'started';
  }

  get intervalMs(): number {
    return this.baseIntervalMs;
  }

  setInterval(ms: number): void {
    this.baseIntervalMs = ms;
  }

  /** True from start() until the first good poll, for at most CONNECTING_TIME_MS */
  isConnecting(id: string): boolean {
    return this.connectingTimers.has(id);
  }

  /** Poll now, then keep polling. Does nothing if the machine is polled already. */
  start(connector: BaseMachineConnector): void {
    if (this.activeIds.has(connector.id)) return;
    this.activeIds.add(connector.id);
    this.failureCounts.set(connector.id, 0);
    connector.pollTimeLimitMs = this.pollTimeoutMs;
    this.startTimes.set(connector.id, Date.now());
    this.endTimes.delete(connector.id);
    this.startConnecting(connector);
    // Do not wait: pollNow sets the next timer when it ends
    void this.pollNow(connector);
  }

  /** A poll that still runs is not stopped, but no poll comes after it */
  stop(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.activeIds.delete(id);
    this.failureCounts.delete(id);
    this.startTimes.delete(id);
    this.endTimes.delete(id);
    this.endConnecting(id);
  }

  stopAll(): void {
    for (const id of [...this.activeIds]) this.stop(id);
  }

  async pollNow(connector: BaseMachineConnector): Promise<void> {
    if (this.pollsInProgress.has(connector.id)) {
      // The last poll ran out of time and still runs. Two polls at once would talk over each other.
      this.scheduleNext(connector);
      return;
    }

    const succeeded = (await this.pollWithTimeout(connector)) && connector.connected;
    // A machine that was stopped or removed during the poll keeps no state, and gets no history
    if (!this.activeIds.has(connector.id)) return;

    this.recordResult(connector.id, succeeded);
    this.endTimes.set(connector.id, Date.now());
    // Before afterPoll, so the status it sends already says that the machine is connected
    if (succeeded) this.endConnecting(connector.id);
    this.hooks.afterPoll(connector);
    this.scheduleNext(connector);
  }

  /**
   * Poll one time. False when the poll fails or runs out of time. The machine stays "in progress" until the poll really ends.
   * A poll that runs out of time disconnects the machine, so its old values do not show as live.
   * When that poll ends later, the machine is disconnected again, so whatever the late poll did
   * (for example a connect that ended after all) does not count. The next poll connects again.
   * A poll that has not ended after STUCK_POLL_MS is left behind (see abandonStuckPoll).
   */
  private async pollWithTimeout(connector: BaseMachineConnector): Promise<boolean> {
    const { id } = connector;
    let timedOut = false;
    const token = Symbol(id);
    this.pollsInProgress.set(id, token);
    const stuckTimer = setTimeout(() => this.abandonStuckPoll(connector, token), this.stuckPollMs);
    this.pollStartTimes.set(id, Date.now());
    // Promise.resolve().then also catches an error that poll() throws before it gives a promise
    const poll = Promise.resolve()
      .then(() => connector.poll())
      .finally(() => {
        clearTimeout(stuckTimer);
        // A poll that was left behind must not end or disconnect the poll that came after it
        if (this.pollsInProgress.get(id) !== token) return;
        this.pollsInProgress.delete(id);
        this.pollStartTimes.delete(id);
        if (timedOut) disconnectQuietly(connector);
      });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        disconnectQuietly(connector);
        connector.reportPollTimeout(this.pollTimeoutMs);
        resolve(false);
      }, this.pollTimeoutMs);
    });

    try {
      return await Promise.race([poll.then(() => true), timeout]);
    } catch {
      // A poll that fails counts as a failure, the same as a poll that runs out of time
      return false;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Stop waiting for a poll that never ended, so the next poll can run. The connector is disconnected again,
   * so the next poll connects again. The scheduler cannot stop the old poll. If the old poll continues after all,
   * it can call connect() or disconnect() while the next poll runs. We accept this risk: a stuck poll is a bug
   * in a connector, and this is better than a machine that stays offline until Chatter restarts.
   */
  private abandonStuckPoll(connector: BaseMachineConnector, token: symbol): void {
    if (this.pollsInProgress.get(connector.id) !== token) return;
    this.pollsInProgress.delete(connector.id);
    this.pollStartTimes.delete(connector.id);
    disconnectQuietly(connector);
    log.warn('A poll did not end, so the next poll starts without it', { machine: connector.id, waitedMs: this.stuckPollMs });
  }

  private startConnecting(connector: BaseMachineConnector, timeMs = CONNECTING_TIME_MS): void {
    const timer = setTimeout(() => {
      const networkWaitMs = NETWORK_WAIT_MS - this.uptimeMs();
      if (networkWaitMs > 0 && isNetworkNotReady(connector)) {
        this.startConnecting(connector, networkWaitMs);
        return;
      }
      this.connectingTimers.delete(connector.id);
      this.hooks.connectingEnded(connector);
    }, timeMs);
    this.connectingTimers.set(connector.id, timer);
  }

  private endConnecting(id: string): void {
    clearTimeout(this.connectingTimers.get(id));
    this.connectingTimers.delete(id);
  }

  private recordResult(id: string, succeeded: boolean): void {
    const failures = succeeded ? 0 : (this.failureCounts.get(id) ?? 0) + 1;
    this.failureCounts.set(id, failures);
  }

  private scheduleNext(connector: BaseMachineConnector): void {
    clearTimeout(this.timers.get(connector.id));
    if (!this.activeIds.has(connector.id)) return;

    const timer = setTimeout(() => void this.pollNow(connector), this.nextIntervalMs(connector.id));
    this.timers.set(connector.id, timer);
  }

  private nextIntervalMs(id: string): number {
    const failures = this.failureCounts.get(id) ?? 0;
    const backoffMs = BACKOFF_STEPS.filter(step => failures >= step.minFailures).pop()?.intervalMs ?? 0;
    return Math.max(this.baseIntervalMs, backoffMs);
  }
}
