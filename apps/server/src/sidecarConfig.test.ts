import { describe, expect, it, vi } from 'vitest';
import { parseSidecarFlags, startOutboundNotifications } from './sidecarConfig.js';

describe('parseSidecarFlags', () => {
  it('leaves CHATTER_DISABLE_HISTORY, CHATTER_DISABLE_UPDATE_CHECK, and CHATTER_DISABLE_WEB_UI off when they are unset', () => {
    expect(parseSidecarFlags({})).toEqual({
      disableHistory: false,
      disableUpdateCheck: false,
      disableWebUi: false,
    });
  });

  it('turns on CHATTER_DISABLE_HISTORY, CHATTER_DISABLE_UPDATE_CHECK, and CHATTER_DISABLE_WEB_UI for 1, true, yes, and on', () => {
    expect(parseSidecarFlags({
      CHATTER_DISABLE_HISTORY: '1',
      CHATTER_DISABLE_UPDATE_CHECK: 'true',
      CHATTER_DISABLE_WEB_UI: 'yes',
    })).toEqual({
      disableHistory: true,
      disableUpdateCheck: true,
      disableWebUi: true,
    });
    expect(parseSidecarFlags({ CHATTER_DISABLE_HISTORY: 'on' }).disableHistory).toBe(true);
    expect(parseSidecarFlags({ CHATTER_DISABLE_UPDATE_CHECK: 'on' }).disableUpdateCheck).toBe(true);
    expect(parseSidecarFlags({ CHATTER_DISABLE_WEB_UI: 'on' }).disableWebUi).toBe(true);
  });

  it('accepts capital letters and surrounding spaces', () => {
    expect(parseSidecarFlags({
      CHATTER_DISABLE_HISTORY: ' TRUE ',
      CHATTER_DISABLE_UPDATE_CHECK: ' Yes ',
      CHATTER_DISABLE_WEB_UI: ' ON ',
    })).toEqual({
      disableHistory: true,
      disableUpdateCheck: true,
      disableWebUi: true,
    });
  });

  it('leaves each flag off for 0, false, no, off, and an empty value', () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      expect(parseSidecarFlags({
        CHATTER_DISABLE_HISTORY: value,
        CHATTER_DISABLE_UPDATE_CHECK: value,
        CHATTER_DISABLE_WEB_UI: value,
      })).toEqual({
        disableHistory: false,
        disableUpdateCheck: false,
        disableWebUi: false,
      });
    }
  });
});

describe('startOutboundNotifications', () => {
  it('starts the sender when CHATTER_DISABLE_HISTORY is off', () => {
    const start = vi.fn();

    expect(startOutboundNotifications({ start }, parseSidecarFlags({}))).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('starts the sender when only the update check is off', () => {
    const start = vi.fn();

    expect(startOutboundNotifications({ start }, parseSidecarFlags({ CHATTER_DISABLE_UPDATE_CHECK: 'true' }))).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('leaves the sender stopped when CHATTER_DISABLE_HISTORY is on, so a saved queue is not polled', () => {
    const start = vi.fn();

    expect(startOutboundNotifications({ start }, parseSidecarFlags({
      CHATTER_DISABLE_HISTORY: '1',
      CHATTER_DISABLE_UPDATE_CHECK: '1',
      CHATTER_DISABLE_WEB_UI: '1',
    }))).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
