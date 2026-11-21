import { ALERT_END_GRACE_MS } from '@local-chatter/shared';
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
   */
  private addResolvedColumn(now: number): void {
    const columns = this.db.prepare('PRAGMA table_info(alerts)').all() as { name: string }[];
    if (columns.some(column => column.name === 'resolved')) return;
    this.db.transaction(() => {
      this.db.exec('ALTER TABLE alerts ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
      this.db.prepare('UPDATE alerts SET resolved = 1 WHERE ends_at <= ?').run(now);
    })();
  }

  /** For tests: the alerts are kept in memory only */
  static inMemory(): AlertStore {
    return new AlertStore(new Database(':memory:'));
  }

  /** Add new alerts, and update the end time and the text of known ones. Also removes alerts older than a year. */
  save(alerts: Alert[], now: number): void {
    const upsert = this.db.prepare(`
      INSERT INTO alerts (name, machine_id, labels, annotations, starts_at, ends_at, resolved)
      VALUES (@name, @machineId, @labels, @annotations, @startsAt, @endsAt, @resolved)
      ON CONFLICT (labels, starts_at) DO UPDATE SET
        annotations = excluded.annotations, ends_at = excluded.ends_at, resolved = excluded.resolved
    `);
    this.db.transaction(() => {
      for (const alert of alerts) {
        upsert.run(toSqlParameters(alert));
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
    // The labels are sorted, so the same labels in another order are the same alert
    labels: JSON.stringify(sortedLabels(alert.labels)),
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

function sortedLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}
