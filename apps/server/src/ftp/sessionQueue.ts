/**
 * Many CNC FTP servers accept only one session at a time. A second session can fail, or confuse the control.
 * So each machine has one queue, and its FTP tasks (list, tree walk, download, upload, delete) run one at a time.
 */

/** A task waits at most this long for its turn. A normal tree walk (with its login) takes less time. */
export const SESSION_WAIT_LIMIT_MS = 3 * 60_000;
/**
 * The most tasks that wait for one machine. A task that comes when the queue is full fails at once.
 * This limit does not protect the memory of a Pi: the upload route reads the files before it queues the upload, and
 * each machine has its own queue. So the upload route has its own limit for all machines.
 */
export const MAX_WAITING_TASKS = 5;
/** The start of each busy text. The guide tells the user this text. */
const BUSY_TEXT = 'The machine is busy with other file tasks.';

/** The machine is busy with other FTP tasks, so this task did not start */
export class MachineBusyError extends Error {}

export interface SessionQueueLimits {
  waitLimitMs: number;
  maxWaiting: number;
}

const DEFAULT_LIMITS: SessionQueueLimits = { waitLimitMs: SESSION_WAIT_LIMIT_MS, maxWaiting: MAX_WAITING_TASKS };

/** A task that waits for its turn. `start` gives it the turn. */
interface Waiter {
  start: () => void;
}

function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Runs one task at a time, in the order that the tasks came */
export class SessionQueue {
  private isBusy = false;
  private readonly waiting: Waiter[] = [];
  private readonly limits: SessionQueueLimits;

  constructor(limits: Partial<SessionQueueLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** The number of tasks that wait now */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** True when a task runs now, so a new task must wait for its turn */
  get hasRunningTask(): boolean {
    return this.isBusy;
  }

  /** The error for a task that cannot wait, for example when the queue is full */
  static busyError(): MachineBusyError {
    return new MachineBusyError(`${BUSY_TEXT} Try again later.`);
  }

  /**
   * Run `work` when no other task runs. The next task starts when `work` ends, also when it fails.
   * `signal` stops the wait: the task leaves the queue, and the promise rejects with the reason of the signal.
   * A task that cannot get its turn in the wait limit, or that comes when the queue is full, rejects with a
   * MachineBusyError.
   */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.takeTurn(signal);
    try {
      return await work();
    } finally {
      this.passTurn();
    }
  }

  private takeTurn(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isBusy) {
      this.isBusy = true;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.limits.maxWaiting) {
      return Promise.reject(SessionQueue.busyError());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          stopWatching();
          resolve();
        },
      };
      const leave = (reason: unknown) => {
        // With no match, indexOf gives -1, and splice(-1, 1) would remove the last waiter
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        stopWatching();
        reject(reason);
      };
      const timer = setTimeout(() => leave(new MachineBusyError(
        `${BUSY_TEXT} Chatter waited ${minutesText(this.limits.waitLimitMs)}. Try again later.`
      )), this.limits.waitLimitMs);
      const onAbort = () => leave(signal?.reason);
      const stopWatching = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** Give the turn to the next task. The queue stays busy, so no new task can start between the two. */
  private passTurn(): void {
    const next = this.waiting.shift();
    if (next) next.start();
    else this.isBusy = false;
  }
}
