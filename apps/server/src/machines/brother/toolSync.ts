import type { ToolSyncState } from '@local-chatter/shared';

/**
 * The tool table (ATC) and the tool data (TOLN) are big replies, like a file, and they change only when an
 * operator loads or measures a tool. So Chatter reads them automatically only when the machine runs no program,
 * and the last good read is more than 10 minutes old. A user can read them at any time with the Sync button.
 */
export const TOOL_SYNC_MIN_AGE_MS = 10 * 60_000;

/**
 * At most one Sync request in 30 seconds for each machine, so many clicks do not keep the one connection of
 * the control busy. After a failed automatic read, the next automatic read also waits this long.
 */
export const MANUAL_SYNC_EVERY_MS = 30_000;

/**
 * A tool read can take longer than a state poll: on a slow Brother, 2 or 3 replies of up to 5 s each.
 * 20 s is more than that, and a read that is still not done then is stuck.
 */
export const TOOL_SYNC_TIMEOUT_MS = 20_000;

/** Why the server does not start a Sync now */
export type ToolSyncRefusal = { outcome: 'busy' } | { outcome: 'too-soon'; retryAfterSeconds: number };

/**
 * True when the machine runs no program. Without a run state from the control (an older control, or a status
 * that Chatter does not know), only when the spindle stands still.
 */
export function isIdle(data: { execution?: unknown; spindleSpeed?: unknown }): boolean {
  if (data.execution === 'READY') return true;
  if (data.execution !== '' && data.execution !== undefined) return false;
  return data.spindleSpeed === 0;
}

const isoOrNull = (time: number | null) => (time === null ? null : new Date(time).toISOString());

/** When the tools were read, how the last read ended, and whether a read runs */
export class ToolSyncTracker {
  private lastSyncAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastManualAt: number | null = null;
  private error: string | null = null;
  private running = false;

  started(now: number, trigger: 'auto' | 'manual'): void {
    this.running = true;
    if (trigger === 'manual') this.lastManualAt = now;
  }

  /** `error` is null for a good read */
  ended(now: number, error: string | null): void {
    this.running = false;
    this.lastAttemptAt = now;
    this.error = error;
    if (error === null) this.lastSyncAt = now;
  }

  /** The read ended, but its result is not kept (the address changed during it). Only `running` changes. */
  abandoned(): void {
    this.running = false;
  }

  /**
   * Forget the last read, so the next idle poll reads the tools at once. A read that runs now and the Sync limit
   * of 30 seconds stay.
   */
  forgetLastRead(): void {
    this.lastSyncAt = null;
    this.lastAttemptAt = null;
    this.error = null;
  }

  autoSyncDue(now: number): boolean {
    if (this.running) return false;
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < MANUAL_SYNC_EVERY_MS) return false;
    return this.lastSyncAt === null || now - this.lastSyncAt > TOOL_SYNC_MIN_AGE_MS;
  }

  /** Null when a Sync request can start now */
  manualRefusal(now: number): ToolSyncRefusal | null {
    if (this.running) return { outcome: 'busy' };
    if (this.lastManualAt !== null && now - this.lastManualAt < MANUAL_SYNC_EVERY_MS) {
      return { outcome: 'too-soon', retryAfterSeconds: Math.ceil((MANUAL_SYNC_EVERY_MS - (now - this.lastManualAt)) / 1000) };
    }
    return null;
  }

  state(): ToolSyncState {
    return { lastSyncAt: isoOrNull(this.lastSyncAt), lastAttemptAt: isoOrNull(this.lastAttemptAt), error: this.error, running: this.running };
  }
}
