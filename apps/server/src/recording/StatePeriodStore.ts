import Database from 'better-sqlite3';
import { STATE_PERIOD_KINDS, type StatePeriodKind } from '@local-chatter/shared';

/** One time when a machine state had one value. `end` is undefined while the period still runs. */
export interface StatePeriod {
  kind: StatePeriodKind;
  value: string;
  start: number;
  end?: number;
}

export interface PeriodQuery {
  machineId: string;
  from: number;
  to: number;
  kind?: StatePeriodKind;
  limit: number;
}

interface StatePeriodRow {
  id: number;
  kind: StatePeriodKind;
  value: string;
  started_at: number;
  ended_at: number | null;
}

/** The periods that start in the time, newest first. The index reads only that time, not the older history. */
export const PERIODS_STARTED_IN_SQL = `
  SELECT id, kind, value, started_at, ended_at FROM state_periods
  WHERE machine_id = @machineId AND started_at >= @from AND started_at < @to AND (@kind IS NULL OR kind = @kind)
  ORDER BY started_at DESC, id DESC
  LIMIT @limit`;

/**
 * The newest period of one kind that starts before the time. Only that one can still be open then, because a new
 * period of a kind starts when the last one ends. The end is not in the query: with it, SQLite would read back
 * through the whole history to find a period that matches.
 */
export const PERIODS_BEFORE_SQL = `
  SELECT id, kind, value, started_at, ended_at FROM state_periods
  WHERE machine_id = @machineId AND kind = @kind AND started_at < @from
  ORDER BY started_at DESC, id DESC
  LIMIT 1`;

/**
 * The state periods, in the "state_periods" table of the SQLite database. Times are in milliseconds since 1970.
 * `seen_at` is the last time that ChatterBox saw an open period, so a period that a power cut left open
 * can end at that time when ChatterBox starts again.
 */
export class StatePeriodStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS state_periods_machine_start ON state_periods (machine_id, started_at);
      CREATE INDEX IF NOT EXISTS state_periods_machine_kind_start ON state_periods (machine_id, kind, started_at);
    `);
  }

  /** For tests: the periods are kept in memory only */
  static inMemory(): StatePeriodStore {
    return new StatePeriodStore(new Database(':memory:'));
  }

  inTransaction(work: () => void): void {
    this.db.transaction(work)();
  }

  open(machineId: string, kind: StatePeriodKind, value: string, time: number): void {
    this.db.prepare('INSERT INTO state_periods (machine_id, kind, value, started_at, seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(machineId, kind, value, time, time);
  }

  close(machineId: string, kind: StatePeriodKind, time: number): void {
    this.db.prepare('UPDATE state_periods SET ended_at = ? WHERE machine_id = ? AND kind = ? AND ended_at IS NULL')
      .run(time, machineId, kind);
  }

  markSeen(machineId: string, time: number): void {
    this.db.prepare('UPDATE state_periods SET seen_at = ? WHERE machine_id = ? AND ended_at IS NULL').run(time, machineId);
  }

  /** End every open period now, for example when ChatterBox stops */
  closeAll(time: number): void {
    this.db.prepare('UPDATE state_periods SET ended_at = ? WHERE ended_at IS NULL').run(time);
  }

  /** End the periods that a sudden stop left open, at the last time ChatterBox saw them */
  closeLeftovers(): void {
    this.db.prepare('UPDATE state_periods SET ended_at = seen_at WHERE ended_at IS NULL').run();
  }

  /**
   * The periods that overlap the time from `from` to `to`, newest first: the ones that start in the time,
   * then for each kind the one that started before and is still open at `from`.
   * Two small queries, so a Pi with a year of periods reads only the asked time.
   */
  read({ machineId, from, to, kind, limit }: PeriodQuery): StatePeriod[] {
    const startedIn = this.db.prepare(PERIODS_STARTED_IN_SQL)
      .all({ machineId, from, to, kind: kind ?? null, limit }) as StatePeriodRow[];
    const findBefore = this.db.prepare(PERIODS_BEFORE_SQL);
    const openAtFrom = (kind ? [kind] : STATE_PERIOD_KINDS)
      .map(oneKind => findBefore.get({ machineId, kind: oneKind, from }) as StatePeriodRow | undefined)
      .filter((row): row is StatePeriodRow => row !== undefined && (row.ended_at === null || row.ended_at > from));
    return [...startedIn, ...openAtFrom]
      .sort((a, b) => b.started_at - a.started_at || b.id - a.id)
      .slice(0, limit)
      .map(toStatePeriod);
  }

  removeMachine(machineId: string): void {
    this.db.prepare('DELETE FROM state_periods WHERE machine_id = ?').run(machineId);
  }

  removeEndedBefore(time: number): void {
    this.db.prepare('DELETE FROM state_periods WHERE ended_at < ?').run(time);
  }
}

function toStatePeriod(row: StatePeriodRow): StatePeriod {
  return { kind: row.kind, value: row.value, start: row.started_at, end: row.ended_at ?? undefined };
}
