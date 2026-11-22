import { ALERT_END_GRACE_MS, EVENT_LABEL } from '@local-chatter/shared';
import Database from 'better-sqlite3';

/** Alerts are kept this long after they end, like the machine history */
export const KEEP_ALERTS_MS = 365 * 24 * 60 * 60_000;

/** One alert from vmalert. Times are in milliseconds since 1970. */
export interface Alert {
  name: string;
  /** The machine id from the "machine" label. Undefined for an alert that is not about one machine. */
  machineId?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: number;
  /** While the alert fires, this is in the future. vmalert sends the alert again before this time. */
  endsAt: number;
  /** True when vmalert said that the alert ended. Then `endsAt` is the real end. See isAlertFiring(). */
  resolved: boolean;
}

export interface AlertQuery {
  now: number;
  machineId?: string;
  /** Only alerts that fire now */
  firingOnly: boolean;
  /** Also alerts that ended after this time */
  endedAfter: number;
  limit: number;
}

/** The columns that make an AlertRow */
export const ALERT_COLUMNS = 'name, machine_id, labels, annotations, starts_at, ends_at, resolved';

/**
 * The SQL of alertFiringUntil() for a row of the "alerts" table: the time from which the alert counts as ended.
 * An alert fires while this is after now.
 */
export const FIRING_UNTIL_SQL = `(CASE WHEN resolved THEN ends_at ELSE ends_at + ${ALERT_END_GRACE_MS} END)`;

/**
 * vmalert gives a firing alert an end time 4 checks ahead of each send: 1 minute, because the rules file checks every
 * 15 seconds. So the last send of an alert was this long before its end time.
 */
export const VMALERT_LEASE_MS = 60_000;

/** What vmalert has now: GET /api/v1/rules (see VmalertAlertSync) */
export interface VmalertState {
  /** The alerts that fire now */
  firing: { labels: Record<string, string> }[];
  /** The time of the last check of each alert rule, by `group name\nrule name` */
  lastChecks: Map<string, number>;
}

/** One row of the "alerts" table */
export interface AlertRow {
  name: string;
  machine_id: string | null;
  labels: string;
  annotations: string;
  starts_at: number;
  ends_at: number;
  /** 1 when vmalert said that the alert ended */
  resolved: number;
}

/**
 * The alerts that vmalert sends, in the "alerts" table of the SQLite database.
 * vmalert sends a firing alert again and again. One alert is one row: the same labels and the same start time.
 */
export class AlertStore {
  /** `now` is for the first start after the update that adds the "resolved" column */
  constructor(private readonly db: Database.Database, now = Date.now()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        machine_id TEXT,
        labels TEXT NOT NULL,
        annotations TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        UNIQUE (labels, starts_at)
      );
      CREATE INDEX IF NOT EXISTS alerts_ends_at ON alerts (ends_at);
    `);
    this.addResolvedColumn(now);
  }

  /**
   * Older versions kept no "resolved" flag: an alert ended when its end time passed.
   * The alerts that ended before the update are marked as resolved, so they do not fire again for the grace time.
   * An alert that fired when the older version stopped is not resolved: its end time passed during the update,
   * and vmalert sends it again. A resolved alert ends at once after a start, so it would get a wrong "ended" message.
   */
  private addResolvedColumn(now: number): void {
    const columns = this.db.prepare('PRAGMA table_info(alerts)').all() as { name: string }[];
    if (columns.some(column => column.name === 'resolved')) return;
    this.db.transaction(() => {
      this.db.exec('ALTER TABLE alerts ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
      this.db.prepare(`UPDATE alerts SET resolved = 1 WHERE ${this.endedBeforeUpdateSql()}`).run({ now });
    })();
  }

  /**
   * With notifications, the older version kept an "ended" note for each alert that it reported as ended
   * (see AlertChangeFinder). Only these alerts ended: an update can take longer than the grace time.
   * With no notes, an alert ended when its end time passed by more than the grace time. No channel is set up then,
   * so no message can be wrong. The update reads the notes only one time, and AlertChangeFinder keeps them.
   */
  private endedBeforeUpdateSql(): string {
    const hasNotes = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alert_notices'").get();
    if (hasNotes) return "id IN (SELECT alert_id FROM alert_notices WHERE kind = 'ended')";
    return `ends_at <= @now - ${ALERT_END_GRACE_MS}`;
  }

  /** For tests: the alerts are kept in memory only */
  static inMemory(): AlertStore {
    return new AlertStore(new Database(':memory:'));
  }

  /**
   * Add new alerts, and update the end time and the text of known ones. Also removes alerts older than a year.
   * A start time that is new for an alert that still fires (with the same labels) updates that alert: after a restart,
   * vmalert gives a firing alert a new start time when its rule fires at the first check. It is not a new alert.
   * An event, such as "program ended", is different: each start is a new event.
   */
  save(alerts: Alert[], now: number): void {
    const upsert = this.db.prepare(`
      INSERT INTO alerts (name, machine_id, labels, annotations, starts_at, ends_at, resolved)
      VALUES (@name, @machineId, @labels, @annotations, @startsAt, @endsAt, @resolved)
      ON CONFLICT (labels, starts_at) DO UPDATE SET
        annotations = excluded.annotations, ends_at = excluded.ends_at, resolved = excluded.resolved
    `);
    const firingWithEarlierStart = this.db.prepare(`
      SELECT id FROM alerts
      WHERE labels = @labels AND starts_at < @startsAt AND ${FIRING_UNTIL_SQL} > @now
      ORDER BY starts_at DESC LIMIT 1
    `).pluck();
    const update = this.db.prepare(`
      UPDATE alerts SET annotations = @annotations, ends_at = @endsAt, resolved = @resolved WHERE id = @id
    `);
    this.db.transaction(() => {
      for (const alert of alerts) {
        const parameters = toSqlParameters(alert);
        const isEvent = alert.labels[EVENT_LABEL] === 'true';
        const id = isEvent ? undefined : firingWithEarlierStart.get({ ...parameters, now }) as number | undefined;
        if (id === undefined) upsert.run(parameters);
        else update.run({ ...parameters, id });
      }
      this.removeEndedBefore(now - KEEP_ALERTS_MS);
    })();
  }

  /** Newest first. An alert in the grace time after its end time still fires (see isAlertFiring). */
  read({ now, machineId, firingOnly, endedAfter, limit }: AlertQuery): Alert[] {
    // The first test of ends_at can use the index
    const rows = this.db.prepare(`
      SELECT ${ALERT_COLUMNS} FROM alerts
      WHERE ends_at > @endsAfter - ${ALERT_END_GRACE_MS} AND ${FIRING_UNTIL_SQL} > @endsAfter
        AND (@machineId IS NULL OR machine_id = @machineId)
      ORDER BY starts_at DESC, id DESC
      LIMIT @limit
    `).all({ endsAfter: firingOnly ? now : endedAfter, machineId: machineId ?? null, limit }) as AlertRow[];
    return rows.map(toAlert);
  }

  /**
   * Make the firing alerts match what vmalert has now. vmalert does not send again what it could not send,
   * for example a resolve while Chatter restarted.
   * An alert that vmalert still fires gets a new end time. An alert that vmalert does not have any more is resolved,
   * but only when vmalert checked its rule after the last send. Else vmalert could still be at its first check.
   * It adds no alert: vmalert sends each firing alert at each check, with its real start time.
   */
  updateFromVmalert({ firing, lastChecks }: VmalertState, now: number): { renewed: number; ended: number } {
    const firingLabels = new Set(firing.map(alert => labelsText(alert.labels)));
    const openRows = this.db.prepare(`
      SELECT id, labels, ends_at FROM alerts WHERE NOT resolved AND ${FIRING_UNTIL_SQL} > ?
    `);
    const renew = this.db.prepare('UPDATE alerts SET ends_at = MAX(ends_at, @endsAt) WHERE id = @id');
    const resolve = this.db.prepare('UPDATE alerts SET ends_at = MIN(ends_at, @now), resolved = 1 WHERE id = @id');
    const result = { renewed: 0, ended: 0 };
    this.db.transaction(() => {
      for (const row of openRows.all(now) as { id: number; labels: string; ends_at: number }[]) {
        if (firingLabels.has(row.labels)) {
          renew.run({ id: row.id, endsAt: now + VMALERT_LEASE_MS });
          result.renewed++;
          continue;
        }
        const labels = parseTextRecord(row.labels);
        const lastCheck = lastChecks.get(`${labels.alertgroup}\n${labels.alertname}`);
        if (lastCheck !== undefined && lastCheck > row.ends_at - VMALERT_LEASE_MS) {
          resolve.run({ id: row.id, now });
          result.ended++;
        }
      }
    })();
    return result;
  }

  removeMachine(machineId: string): void {
    this.db.prepare('DELETE FROM alerts WHERE machine_id = ?').run(machineId);
  }

  private removeEndedBefore(time: number): void {
    this.db.prepare('DELETE FROM alerts WHERE ends_at < ?').run(time);
  }
}

function toSqlParameters(alert: Alert) {
  return {
    name: alert.name,
    machineId: alert.machineId ?? null,
    labels: labelsText(alert.labels),
    annotations: JSON.stringify(alert.annotations),
    startsAt: alert.startsAt,
    endsAt: alert.endsAt,
    resolved: alert.resolved ? 1 : 0,
  };
}

export function toAlert(row: AlertRow): Alert {
  return {
    name: row.name,
    machineId: row.machine_id ?? undefined,
    labels: parseTextRecord(row.labels),
    annotations: parseTextRecord(row.annotations),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    resolved: row.resolved === 1,
  };
}

function parseTextRecord(json: string): Record<string, string> {
  return JSON.parse(json) as Record<string, string>;
}

/** The labels are sorted, so the same labels in another order are the same alert */
function labelsText(labels: Record<string, string>): string {
  return JSON.stringify(sortedLabels(labels));
}

function sortedLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}
