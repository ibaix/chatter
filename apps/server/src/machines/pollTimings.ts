import { slowestCommands, type PollTimings, type TimingStats } from '@local-chatter/shared';
import { createLogger } from '../logging/logger.js';

const log = createLogger('poll-times');

/**
 * The average and the maximum use the last 50 samples of each command and of the poll: at the default
 * 2 s poll interval, that is the last 100 seconds or more. The memory stays small and the same however long
 * Chatter runs, and a slow spell (for example a tool change) leaves the maximum after a few minutes.
 */
export const TIMING_SAMPLES = 50;

/**
 * A poll that takes more than 60 % of its limit gives a warning. At the 10 s limit that is 6 s: the machine
 * still answers in time, but a few slower replies would make it go offline. The warning tells this early.
 */
const WARN_SHARE = 0.6;

/** At most one warning in 10 minutes for each machine, so a machine that is always slow does not fill the log */
export const WARN_EVERY_MS = 10 * 60_000;

/** The slowest commands that the warning names */
const SLOWEST_IN_WARNING = 3;

/** The last samples of one time. The oldest goes when a new one comes after TIMING_SAMPLES. */
class RecentTimes {
  private readonly samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > TIMING_SAMPLES) this.samples.shift();
  }

  stats(): TimingStats {
    const total = this.samples.reduce((sum, ms) => sum + ms, 0);
    return {
      lastMs: this.samples.at(-1) ?? 0,
      avgMs: Math.round(total / Math.max(this.samples.length, 1)),
      maxMs: Math.max(0, ...this.samples),
      samples: this.samples.length,
    };
  }
}

/**
 * Measures how long each command of a poll and the whole poll take, for one machine.
 * The machine status shows the times, and the log tells when a poll comes near its time limit.
 */
export class PollTimingRecorder {
  private readonly commands = new Map<string, RecentTimes>();
  private readonly polls = new RecentTimes();
  private pollStart = 0;
  private current: { commands: Record<string, number>; skipped: string[] } = { commands: {}, skipped: [] };
  private lastPoll: PollTimings['lastPoll'] | null = null;
  private limitMs = 0;
  private lastWarningAt = -Infinity;
  private readonly plannedReconnects: PollTimings['plannedReconnects'] = { count: 0, lastAt: null };

  /** `now` is for tests */
  constructor(private readonly machineId: string, private readonly now: () => number = Date.now) {}

  startPoll(): void {
    this.pollStart = this.now();
    this.current = { commands: {}, skipped: [] };
  }

  /** The time since the poll started */
  elapsedMs(): number {
    return this.now() - this.pollStart;
  }

  /** Run one command and record how long it took, also when it fails */
  async time<T>(command: string, send: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await send();
    } finally {
      const ms = this.now() - start;
      this.current.commands[command] = ms;
      this.timesOf(command).add(ms);
    }
  }

  /** The poll did not send this optional command, because too little time was left */
  skip(command: string): void {
    this.current.skipped.push(command);
  }

  /**
   * How long the command will probably take: the longer of its last and its average time.
   * The last time follows a machine that becomes slow at once, and the average keeps one fast reply from counting too much.
   */
  estimateMs(command: string): number | undefined {
    const times = this.commands.get(command);
    if (!times) return undefined;
    const { lastMs, avgMs } = times.stats();
    return Math.max(lastMs, avgMs);
  }

  /** The connector closed the connection on purpose, and opens it again */
  recordPlannedReconnect(): void {
    this.plannedReconnects.count++;
    this.plannedReconnects.lastAt = new Date(this.now()).toISOString();
  }

  /** The time of the slowest command of this poll so far. A machine that is slow now is slow for the next command too. */
  slowestInPollMs(): number {
    return Math.max(0, ...Object.values(this.current.commands));
  }

  endPoll(limitMs: number): void {
    const totalMs = this.elapsedMs();
    this.polls.add(totalMs);
    this.limitMs = limitMs;
    this.lastPoll = { at: new Date(this.now()).toISOString(), totalMs, ...this.current };
    const timings = this.snapshot()!;

    log.debug('Poll times', {
      machine: this.machineId,
      totalMs,
      commands: Object.entries(this.current.commands).map(([command, ms]) => `${command}=${ms}`).join(' '),
      skipped: this.current.skipped.length > 0 ? this.current.skipped.join(' ') : undefined,
    });
    if (totalMs > limitMs * WARN_SHARE) this.warnSlowPoll(timings);
  }

  /** Undefined until the first poll ends */
  snapshot(): PollTimings | undefined {
    if (!this.lastPoll) return undefined;
    return {
      limitMs: this.limitMs,
      poll: this.polls.stats(),
      commands: Object.fromEntries([...this.commands].map(([command, times]) => [command, times.stats()])),
      lastPoll: { ...this.lastPoll, commands: { ...this.lastPoll.commands }, skipped: [...this.lastPoll.skipped] },
      plannedReconnects: { ...this.plannedReconnects },
    };
  }

  private timesOf(command: string): RecentTimes {
    let times = this.commands.get(command);
    if (!times) {
      times = new RecentTimes();
      this.commands.set(command, times);
    }
    return times;
  }

  private warnSlowPoll(timings: PollTimings): void {
    const now = this.now();
    if (now - this.lastWarningAt < WARN_EVERY_MS) return;
    this.lastWarningAt = now;
    log.warn('A poll used most of its time limit. The machine answers slowly, and can go offline.', {
      machine: this.machineId,
      totalMs: timings.lastPoll.totalMs,
      limitMs: timings.limitMs,
      slowest: slowestCommands(timings, SLOWEST_IN_WARNING).map(({ command, ms }) => `${command} ${ms} ms`).join(', '),
    });
  }
}
