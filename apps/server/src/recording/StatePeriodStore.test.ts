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

describe('StatePeriodStore backup and restore', () => {
  function storeWithPeriods() {
    const store = StatePeriodStore.inMemory();
    store.open('m1', 'tool', '1', 0);
    store.close('m1', 'tool', 10 * MINUTE);
    store.open('m1', 'tool', '2', 10 * MINUTE);
    store.markSeen('m1', 15 * MINUTE);
    store.open('m1', 'program', 'O1', 30 * MINUTE);
    store.open('m2', 'tool', '9', 5 * MINUTE);
    return store;
  }

  it('gives the periods of one machine that overlap the range, page by page, and an open period ends at its last seen time', () => {
    const store = storeWithPeriods();
    const first = store.periodsForBackup({ machineId: 'm1', from: 5 * MINUTE, to: 40 * MINUTE, afterId: 0, limit: 2 });
    const second = store.periodsForBackup({ machineId: 'm1', from: 5 * MINUTE, to: 40 * MINUTE, afterId: first.at(-1)!.id, limit: 2 });
    expect([...first, ...second].map(row => row.period)).toEqual([
      { kind: 'tool', value: '1', start: 0, end: 10 * MINUTE },
      { kind: 'tool', value: '2', start: 10 * MINUTE, end: 15 * MINUTE },
      { kind: 'program', value: 'O1', start: 30 * MINUTE, end: 30 * MINUTE },
    ]);
    expect(store.periodsForBackup({ machineId: 'm1', from: 11 * MINUTE, to: 20 * MINUTE, afterId: 0, limit: 10 }).map(row => row.period.value))
      .toEqual(['2']);
    expect(store.periodsForBackup({ machineId: 'm1', from: null, to: 5 * MINUTE, afterId: 0, limit: 10 }).map(row => row.period.value))
      .toEqual(['1']);
  });

  it('adds restored periods to another machine in one step, and a second restore adds nothing', () => {
    const store = storeWithPeriods();
    const periods = store.periodsForBackup({ machineId: 'm1', from: null, to: 60 * MINUTE, afterId: 0, limit: 10 }).map(row => row.period);
    const restore = () => {
      const stage = store.startRestore();
      try {
        stage.add(periods);
        return stage.commit('m3', () => {});
      } finally {
        stage.drop();
      }
    };

    expect(restore()).toEqual({ added: 3, known: 0 });
    expect(restore()).toEqual({ added: 0, known: 3 });
    const read = store.read({ machineId: 'm3', from: 0, to: 60 * MINUTE, limit: 10 });
    expect(read.map(period => `${period.kind} ${period.value} ${period.start}-${period.end}`).sort())
      .toEqual(['program O1 1800000-1800000', 'tool 1 0-600000', 'tool 2 600000-900000']);
  });

  it('adds each restored period, also two with the same kind and start', () => {
    const store = storeWithPeriods();
    const stage = store.startRestore();
    stage.add([{ kind: 'tool', value: '5', start: 0, end: 1 }, { kind: 'tool', value: '6', start: 0, end: 2 }]);
    expect(stage.commit('m3', () => {})).toEqual({ added: 2, known: 0 });
    stage.drop();
    expect(store.read({ machineId: 'm3', from: 0, to: 60 * MINUTE, limit: 10 }).map(period => period.value).sort()).toEqual(['5', '6']);
  });

  it('adds nothing when the work in the same step fails', () => {
    const store = storeWithPeriods();
    const stage = store.startRestore();
    stage.add([{ kind: 'tool', value: '5', start: 0, end: 1 }]);
    expect(() => stage.commit('m3', () => {
      throw new Error('rules failed');
    })).toThrow('rules failed');
    stage.drop();
    expect(store.read({ machineId: 'm3', from: 0, to: 60 * MINUTE, limit: 10 })).toEqual([]);
  });
});
