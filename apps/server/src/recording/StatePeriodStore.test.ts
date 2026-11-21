import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PERIODS_BEFORE_SQL, PERIODS_STARTED_IN_SQL, StatePeriodStore } from './StatePeriodStore.js';

const MINUTE = 60_000;

describe('StatePeriodStore.read', () => {
  it('gives the periods that overlap the time, newest first, also one that started long before', () => {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'run-state', 'START', -100 * MINUTE);
    store.open('m1', 'tool', '1', -60 * MINUTE);
    store.close('m1', 'tool', -50 * MINUTE);
    store.open('m1', 'tool', '2', -50 * MINUTE);
    store.close('m1', 'tool', 10 * MINUTE);
    store.open('m1', 'tool', '3', 10 * MINUTE);
    store.open('m2', 'tool', '9', 20 * MINUTE);

    const found = store.read({ machineId: 'm1', from: 0, to: 60 * MINUTE, limit: 10 });

    expect(found.map(period => `${period.kind} ${period.value}`)).toEqual(['tool 3', 'tool 2', 'run-state START']);
  });

  it('leaves out a period that ended before the time, and one that starts after it', () => {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'tool', '1', -60 * MINUTE);
    store.close('m1', 'tool', -1 * MINUTE);
    store.open('m1', 'program', 'O1', 61 * MINUTE);

    expect(store.read({ machineId: 'm1', from: 0, to: 60 * MINUTE, limit: 10 })).toEqual([]);
  });

  it('gives only one kind when it is asked, and at most `limit` periods', () => {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'run-state', 'START', -10 * MINUTE);
    for (const minute of [1, 2, 3]) {
      if (minute > 1) store.close('m1', 'alarm', minute * MINUTE);
      store.open('m1', 'alarm', String(minute), minute * MINUTE);
    }

    const found = store.read({ machineId: 'm1', from: 0, to: 60 * MINUTE, kind: 'alarm', limit: 2 });

    expect(found.map(period => period.value)).toEqual(['3', '2']);
  });

  it('reads with the index from both ends, so a year of history is not read for one day', () => {
    // A Pi keeps a year of periods. A query with no lower bound reads back to the oldest one.
    const db = new Database(':memory:');
    new StatePeriodStore(db);
    const planOf = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
      { machineId: 'm1', from: 0, to: 1, kind: null, limit: 1 },
    ) as { detail: string }[]).map(row => row.detail).join(' | ');

    expect(planOf(PERIODS_STARTED_IN_SQL)).toMatch(/USING INDEX state_periods_machine_start \(machine_id=\? AND started_at>\? AND started_at<\?\)/);
    expect(planOf(PERIODS_BEFORE_SQL)).toMatch(/USING INDEX state_periods_machine_kind_start \(machine_id=\? AND kind=\? AND started_at<\?\)/);
  });
});
