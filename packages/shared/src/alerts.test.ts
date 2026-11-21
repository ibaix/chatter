import { describe, expect, it } from 'vitest';
import { ALERT_END_GRACE_MS, alertFiringUntil, isAlertFiring } from './alerts.js';

const NOW = Date.UTC(2026, 10, 21, 21, 48);
const MINUTE_MS = 60_000;

describe('isAlertFiring', () => {
  it('is true while the end time from vmalert is in the future', () => {
    expect(isAlertFiring({ endsAt: NOW + MINUTE_MS, resolved: false }, NOW)).toBe(true);
  });

  it('stays true for the grace time after the end time of a firing alert passes, because vmalert can send it late', () => {
    const lapsed = { endsAt: NOW - ALERT_END_GRACE_MS + 1, resolved: false };

    expect(isAlertFiring(lapsed, NOW)).toBe(true);
    expect(isAlertFiring(lapsed, NOW + 1)).toBe(false);
  });

  it('is false at once after vmalert said that the alert ended', () => {
    expect(isAlertFiring({ endsAt: NOW - 1, resolved: true }, NOW)).toBe(false);
  });

  it('gives the time from which the alert counts as ended', () => {
    expect(alertFiringUntil({ endsAt: NOW, resolved: true })).toBe(NOW);
    expect(alertFiringUntil({ endsAt: NOW, resolved: false })).toBe(NOW + ALERT_END_GRACE_MS);
  });
});
