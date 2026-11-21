/**
 * When an alert from vmalert counts as ended. The server (the API and the messages) and the web app use the same rule.
 *
 * vmalert sends a firing alert again at each check (every 15 seconds), with an end time about 1 minute ahead.
 * When the alert ends, vmalert sends it one more time with its real end time: Chatter keeps that as `resolved`.
 * When vmalert stops sending a firing alert, for example while Chatter restarts, the end time passes with no
 * resolve. Chatter then waits ALERT_END_GRACE_MS more before it says that the alert ended, so a late send keeps it firing.
 */

/**
 * 3 minutes: 12 more checks of vmalert after the end time of 1 minute. A restart of Chatter or of vmalert takes less time.
 * An alert that vmalert does not send any more (for example, after the rule was removed) ends 4 minutes after its last send.
 */
export const ALERT_END_GRACE_MS = 3 * 60_000;

export interface AlertEndFields {
  /** In milliseconds since 1970. While the alert fires, the time until vmalert sends it again. */
  endsAt: number;
  /** True when vmalert said that the alert ended */
  resolved: boolean;
}

/** The time from which the alert counts as ended */
export function alertFiringUntil({ endsAt, resolved }: AlertEndFields): number {
  return resolved ? endsAt : endsAt + ALERT_END_GRACE_MS;
}

export function isAlertFiring(alert: AlertEndFields, now: number): boolean {
  return now < alertFiringUntil(alert);
}
