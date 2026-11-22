import { describe, expect, it } from 'vitest';
import { TOOL_SYNC_MIN_AGE_MS, TOOL_SYNC_MIN_GAP_MS, ToolSyncTracker, isIdle } from './toolSync.js';

const START = Date.parse('2026-11-21T08:00:00Z');
const MINUTE = 60_000;

describe('isIdle', () => {
  it('is idle when the machine runs no program', () => {
    expect(isIdle({ execution: 'READY', spindleSpeed: 1200 })).toBe(true);
  });

  it('is not idle while a program runs, waits in a feed hold, or is interrupted', () => {
    for (const execution of ['ACTIVE', 'FEED_HOLD', 'INTERRUPTED']) {
      expect(isIdle({ execution, spindleSpeed: 0 })).toBe(false);
    }
  });

  it('with no run state from the control, is idle only when the spindle stands still', () => {
    expect(isIdle({ execution: '', spindleSpeed: 0 })).toBe(true);
    expect(isIdle({ execution: undefined, spindleSpeed: 0 })).toBe(true);
    expect(isIdle({ execution: '', spindleSpeed: 800 })).toBe(false);
    expect(isIdle({ execution: '', spindleSpeed: undefined })).toBe(false);
  });
});

describe('ToolSyncTracker', () => {
  it('is not synced at the start, and the first automatic read is due at once', () => {
    const tracker = new ToolSyncTracker();

    expect(tracker.state()).toEqual({ lastSyncAt: null, lastAttemptAt: null, error: null, running: false });
    expect(tracker.autoSyncDue(START)).toBe(true);
  });

  it('reads again automatically only when the last good read is more than 10 minutes old', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');
    tracker.ended(START, null);

    expect(tracker.autoSyncDue(START + TOOL_SYNC_MIN_AGE_MS)).toBe(false);
    expect(tracker.autoSyncDue(START + TOOL_SYNC_MIN_AGE_MS + 1)).toBe(true);
    expect(TOOL_SYNC_MIN_AGE_MS).toBe(10 * MINUTE);
  });

  it('after a failed read, tries again automatically no sooner than 30 seconds later', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');
    tracker.ended(START, 'No reply');

    expect(tracker.autoSyncDue(START + TOOL_SYNC_MIN_GAP_MS - 1)).toBe(false);
    expect(tracker.autoSyncDue(START + TOOL_SYNC_MIN_GAP_MS)).toBe(true);
  });

  it('keeps no result of an abandoned read: only the read stops running', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');
    tracker.ended(START, null);
    tracker.started(START + 20 * MINUTE, 'auto');

    tracker.abandoned('auto');

    expect(tracker.state()).toEqual({ lastSyncAt: new Date(START).toISOString(), lastAttemptAt: new Date(START).toISOString(), error: null, running: false });
  });

  it('accepts a Sync at once after a Sync whose read was abandoned, so the user can press Sync again', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'manual');

    tracker.abandoned('manual');

    expect(tracker.manualRefusal(START + 1000)).toBeNull();
  });

  it('keeps the limit of the Sync button when an automatic read is abandoned', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'manual');
    tracker.ended(START + 1000, null);
    tracker.started(START + 2000, 'auto');

    tracker.abandoned('auto');

    expect(tracker.manualRefusal(START + 3000)).toEqual({ outcome: 'too-soon', retryAfterSeconds: 27 });
  });

  it('is not due while a read runs', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');

    expect(tracker.autoSyncDue(START + 20 * MINUTE)).toBe(false);
    expect(tracker.state().running).toBe(true);
  });

  it('runs from started() until ended() or abandoned()', () => {
    const tracker = new ToolSyncTracker();
    expect(tracker.running).toBe(false);

    tracker.started(START, 'auto');
    expect(tracker.running).toBe(true);
    tracker.ended(START + 1000, null);
    expect(tracker.running).toBe(false);

    tracker.started(START + 2000, 'manual');
    tracker.abandoned('manual');
    expect(tracker.running).toBe(false);
  });

  it('keeps the time of the last good read and the error of the last read', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');
    tracker.ended(START + 1000, null);
    tracker.started(START + 20 * MINUTE, 'auto');
    tracker.ended(START + 20 * MINUTE + 500, 'No reply');

    expect(tracker.state()).toEqual({
      lastSyncAt: new Date(START + 1000).toISOString(),
      lastAttemptAt: new Date(START + 20 * MINUTE + 500).toISOString(),
      error: 'No reply',
      running: false,
    });
  });

  it('refuses a Sync request while a read runs, and a second request within 30 seconds', () => {
    const tracker = new ToolSyncTracker();
    expect(tracker.manualRefusal(START)).toBeNull();
    tracker.started(START, 'manual');

    expect(tracker.manualRefusal(START + 1000)).toEqual({ outcome: 'busy' });
    tracker.ended(START + 2000, null);
    expect(tracker.manualRefusal(START + 10_000)).toEqual({ outcome: 'too-soon', retryAfterSeconds: 20 });
    expect(tracker.manualRefusal(START + TOOL_SYNC_MIN_GAP_MS)).toBeNull();
  });

  it('does not count an automatic read in the limit of the Sync button', () => {
    const tracker = new ToolSyncTracker();
    tracker.started(START, 'auto');
    tracker.ended(START + 1000, null);

    expect(tracker.manualRefusal(START + 2000)).toBeNull();
  });
});
