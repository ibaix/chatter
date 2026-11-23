import { describe, it, expect, afterEach, vi } from 'vitest';
import { MachineBusyError, SESSION_WAIT_LIMIT_MS, SessionQueue } from './sessionQueue.js';

/** A task that runs until the test ends it */
function heldTask() {
  let end!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => { end = resolve; fail = reject; });
  let hasStarted = false;
  const work = () => {
    hasStarted = true;
    return done;
  };
  return { work, end, fail, hasStarted: () => hasStarted };
}

/** Let the promise callbacks that wait now run */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionQueue', () => {
  it('runs one task at a time, in the order that the tasks came', async () => {
    const queue = new SessionQueue();
    const first = heldTask();
    const second = heldTask();
    const third = heldTask();

    const results = [first, second, third].map(task => queue.run(task.work));
    await settle();
    expect([first, second, third].map(task => task.hasStarted())).toEqual([true, false, false]);

    first.end();
    await results[0];
    await settle();
    expect([second, third].map(task => task.hasStarted())).toEqual([true, false]);

    second.end();
    third.end();
    await Promise.all(results);
    expect(third.hasStarted()).toBe(true);
  });

  it('starts the next task after a task fails', async () => {
    const queue = new SessionQueue();
    const failing = heldTask();
    const next = heldTask();

    const failed = queue.run(failing.work);
    const running = queue.run(next.work);
    failing.fail(new Error('550 No such file'));

    await expect(failed).rejects.toThrow('550 No such file');
    await settle();
    expect(next.hasStarted()).toBe(true);
    next.end();
    await running;
  });

  it('starts the next task after a task throws before its first await', async () => {
    const queue = new SessionQueue();

    await expect(queue.run(() => { throw new Error('bad path'); })).rejects.toThrow('bad path');

    await expect(queue.run(async () => 'next')).resolves.toBe('next');
  });

  it('removes a waiting task when its signal aborts, and does not run it', async () => {
    const queue = new SessionQueue();
    const first = heldTask();
    const cancelled = heldTask();
    const last = heldTask();
    const cancel = new AbortController();

    const running = queue.run(first.work);
    const waiting = queue.run(cancelled.work, cancel.signal);
    const lastRun = queue.run(last.work);
    cancel.abort(new Error('The browser left'));

    await expect(waiting).rejects.toThrow('The browser left');
    expect(queue.waitingCount).toBe(1);
    first.end();
    await running;
    await settle();
    expect(cancelled.hasStarted()).toBe(false);
    expect(last.hasStarted()).toBe(true);
    last.end();
    await lastRun;
  });

  it('does not take a turn when the signal aborted before the call', async () => {
    const queue = new SessionQueue();
    const task = heldTask();
    const cancel = new AbortController();
    cancel.abort(new Error('Cancelled'));

    await expect(queue.run(task.work, cancel.signal)).rejects.toThrow('Cancelled');

    expect(task.hasStarted()).toBe(false);
    await expect(queue.run(async () => 'free')).resolves.toBe('free');
  });

  it('fails a task that waits longer than the wait limit, and keeps the order of the others', async () => {
    vi.useFakeTimers();
    const queue = new SessionQueue({ waitLimitMs: 60_000 });
    const stuck = heldTask();
    const running = queue.run(stuck.work);
    const waiting = queue.run(async () => 'late');
    const outcome = waiting.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(60_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(MachineBusyError);
    expect((err as Error).message).toBe('The machine is busy with other file tasks. Chatter waited 1 minute. Try again later.');
    expect(queue.waitingCount).toBe(0);
    stuck.end();
    await running;
  });

  // The guide and docs/security.md tell the user "3 minutes"
  it('waits 3 minutes by default, and tells the user so', async () => {
    vi.useFakeTimers();
    const queue = new SessionQueue();
    const stuck = heldTask();
    const running = queue.run(stuck.work);
    const outcome = queue.run(async () => 'late').catch((err: unknown) => err);

    expect(SESSION_WAIT_LIMIT_MS).toBe(3 * 60_000);
    await vi.advanceTimersByTimeAsync(SESSION_WAIT_LIMIT_MS - 1);
    expect(queue.waitingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(((await outcome) as Error).message).toBe('The machine is busy with other file tasks. Chatter waited 3 minutes. Try again later.');
    stuck.end();
    await running;
  });

  it('does not fail a task that gets its turn before the wait limit', async () => {
    vi.useFakeTimers();
    const queue = new SessionQueue({ waitLimitMs: 60_000 });
    const first = heldTask();
    const running = queue.run(first.work);
    const second = heldTask();
    const waiting = queue.run(second.work);

    await vi.advanceTimersByTimeAsync(59_000);
    first.end();
    await running;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(second.hasStarted()).toBe(true);
    second.end();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('fails a task at once when the queue is full', async () => {
    const queue = new SessionQueue({ maxWaiting: 1 });
    const first = heldTask();
    const second = heldTask();
    const running = queue.run(first.work);
    const waiting = queue.run(second.work);

    await expect(queue.run(async () => 'third')).rejects.toThrow(MachineBusyError);
    expect(queue.waitingCount).toBe(1);

    first.end();
    await running;
    await settle();
    second.end();
    await waiting;
  });
});
