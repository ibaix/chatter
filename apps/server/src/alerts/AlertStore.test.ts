import { ALERT_END_GRACE_MS } from '@local-chatter/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Alert, AlertStore, KEEP_ALERTS_MS } from './AlertStore.js';

const NOW = Date.UTC(2026, 10, 9, 9, 0);
const MINUTE_MS = 60_000;

function anAlert(values: Partial<Alert> = {}): Alert {
  return {
    name: 'SpindleTooFast',
    machineId: 'm1',
    labels: { alertname: 'SpindleTooFast', machine: 'm1' },
    annotations: { summary: 'Spindle speed is 9000' },
    startsAt: NOW - MINUTE_MS,
    endsAt: NOW + MINUTE_MS,
    resolved: false,
    ...values,
  };
}

const firingAlertsQuery = { now: NOW, firingOnly: true, endedAfter: 0, limit: 100 };
const allAlertsQuery = { now: NOW, firingOnly: false, endedAfter: 0, limit: 100 };

describe('AlertStore', () => {
  let store: AlertStore;

  beforeEach(() => {
    store = AlertStore.inMemory();
  });

  it('keeps an alert that vmalert sends again as one alert, with the newest end time and text', () => {
    store.save([anAlert()], NOW);
    const newerValues = { endsAt: NOW + 2 * MINUTE_MS, annotations: { summary: 'Spindle speed is 9500' } };
    store.save([anAlert({ ...newerValues, labels: { machine: 'm1', alertname: 'SpindleTooFast' } })], NOW);

    expect(store.read(allAlertsQuery)).toEqual([anAlert(newerValues)]);
  });

  it('keeps a new start of the same alert as a second alert', () => {
    store.save([anAlert({ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW - 5 * MINUTE_MS })], NOW);
    store.save([anAlert()], NOW);

    expect(store.read(allAlertsQuery)).toHaveLength(2);
  });

  it('gives only the alerts that fire now, when asked', () => {
    store.save([anAlert({ name: 'Ended', endsAt: NOW - 1, resolved: true }), anAlert({ name: 'Firing', labels: { alertname: 'Firing' } })], NOW);

    expect(store.read(firingAlertsQuery).map(found => found.name)).toEqual(['Firing']);
  });

  it('keeps an alert with a passed end time as firing for the grace time, because vmalert can send it late', () => {
    store.save([
      anAlert({ name: 'Late', labels: { alertname: 'Late' }, endsAt: NOW - ALERT_END_GRACE_MS + 1 }),
      anAlert({ name: 'Gone', labels: { alertname: 'Gone' }, endsAt: NOW - ALERT_END_GRACE_MS }),
    ], NOW);

    expect(store.read(firingAlertsQuery).map(found => found.name)).toEqual(['Late']);
  });

  it('gives the alerts of one machine, when asked', () => {
    store.save([anAlert(), anAlert({ machineId: 'm2', labels: { machine: 'm2' } }), anAlert({ machineId: undefined, labels: {} })], NOW);

    expect(store.read({ ...allAlertsQuery, machineId: 'm2' }).map(found => found.machineId)).toEqual(['m2']);
  });

  it('leaves out alerts that ended before the asked time', () => {
    store.save([anAlert({ endsAt: NOW - 60 * MINUTE_MS, resolved: true })], NOW);

    expect(store.read({ ...allAlertsQuery, endedAfter: NOW - MINUTE_MS })).toEqual([]);
  });

  it('removes alerts that ended more than a year ago', () => {
    store.save([anAlert({ startsAt: NOW - KEEP_ALERTS_MS - 2000, endsAt: NOW - KEEP_ALERTS_MS - 1000 })], NOW);

    store.save([], NOW);

    expect(store.read(allAlertsQuery)).toEqual([]);
  });

  it('removes the alerts of a removed machine', () => {
    store.save([anAlert()], NOW);

    store.removeMachine('m1');

    expect(store.read(allAlertsQuery)).toEqual([]);
  });

  describe('the update that adds the resolved flag', () => {
    function oldDatabase(): Database.Database {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, machine_id TEXT, labels TEXT NOT NULL,
          annotations TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, UNIQUE (labels, starts_at)
        );
        INSERT INTO alerts (name, labels, annotations, starts_at, ends_at)
        VALUES ('Ended', '{}', '{}', ${NOW - 5 * MINUTE_MS}, ${NOW - MINUTE_MS}),
               ('Firing', '{}', '{}', ${NOW - 5 * MINUTE_MS + 1}, ${NOW + MINUTE_MS});
      `);
      return db;
    }

    it('marks the alerts that ended before the update as resolved, so they do not fire again for the grace time', () => {
      const updated = new AlertStore(oldDatabase(), NOW);

      expect(updated.read(allAlertsQuery).map(({ name, resolved }) => ({ name, resolved }))).toEqual([
        { name: 'Firing', resolved: false },
        { name: 'Ended', resolved: true },
      ]);
    });

    it('changes nothing at the next start', () => {
      const db = oldDatabase();
      new AlertStore(db, NOW);
      new AlertStore(db, NOW + 10 * MINUTE_MS);

      expect(new AlertStore(db, NOW).read(firingAlertsQuery).map(found => found.name)).toEqual(['Firing']);
    });
  });
});
