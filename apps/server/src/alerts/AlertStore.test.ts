import { ALERT_END_GRACE_MS, EVENT_LABEL } from '@local-chatter/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Alert, AlertStore, KEEP_ALERTS_MS, VMALERT_LEASE_MS, type VmalertState } from './AlertStore.js';

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
    store.save([anAlert({ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW - 5 * MINUTE_MS, resolved: true })], NOW);
    store.save([anAlert()], NOW);

    expect(store.read(allAlertsQuery)).toHaveLength(2);
  });

  it('keeps a firing alert as one alert when vmalert sends it with a new start time, for example after vmalert restarted', () => {
    // vmalert keeps no start time over a restart for a rule that fires at the first check
    store.save([anAlert({ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW - MINUTE_MS })], NOW);
    store.save([anAlert({ startsAt: NOW - 30_000, endsAt: NOW + MINUTE_MS })], NOW);
    store.save([anAlert({ startsAt: NOW - 30_000, endsAt: NOW + 2 * MINUTE_MS })], NOW + MINUTE_MS);

    expect(store.read(allAlertsQuery)).toMatchObject([{ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW + 2 * MINUTE_MS }]);

    store.save([anAlert({ startsAt: NOW - 30_000, endsAt: NOW + 90_000, resolved: true })], NOW + 2 * MINUTE_MS);

    expect(store.read(allAlertsQuery)).toMatchObject([{ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW + 90_000, resolved: true }]);
  });

  it('keeps each start of an event, such as "program ended", as a new alert', () => {
    const labels = { alertname: 'Program ended', machine: 'm1', [EVENT_LABEL]: 'true' };
    store.save([anAlert({ labels, startsAt: NOW - 2 * MINUTE_MS, endsAt: NOW + MINUTE_MS })], NOW);
    store.save([anAlert({ labels, startsAt: NOW - 30_000, endsAt: NOW + MINUTE_MS })], NOW);

    expect(store.read(allAlertsQuery)).toHaveLength(2);
  });

  it('keeps a new start as a second alert when the first alert ended more than the grace time ago', () => {
    store.save([anAlert({ startsAt: NOW - 10 * MINUTE_MS, endsAt: NOW - ALERT_END_GRACE_MS })], NOW);
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
    /**
     * The rows of a version with no notifications. The last send of "Firing" was during the update,
     * and its end time passed by less than the grace time.
     */
    function oldDatabase(): Database.Database {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, machine_id TEXT, labels TEXT NOT NULL,
          annotations TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, UNIQUE (labels, starts_at)
        );
        INSERT INTO alerts (name, labels, annotations, starts_at, ends_at)
        VALUES ('Ended', '{}', '{}', ${NOW - 10 * MINUTE_MS}, ${NOW - ALERT_END_GRACE_MS}),
               ('Firing', '{}', '{}', ${NOW - 10 * MINUTE_MS + 1}, ${NOW - MINUTE_MS});
      `);
      return db;
    }

    /** A version with notifications: AlertChangeFinder kept a note of each change that it reported */
    function oldDatabaseWithNotes(): Database.Database {
      const db = oldDatabase();
      db.exec(`
        INSERT INTO alerts (name, labels, annotations, starts_at, ends_at)
        VALUES ('Ended a short time ago', '{"a":"1"}', '{}', ${NOW - 5 * MINUTE_MS}, ${NOW - MINUTE_MS}),
               ('Firing for a long update', '{"a":"2"}', '{}', ${NOW - 20 * MINUTE_MS}, ${NOW - 10 * MINUTE_MS});
        CREATE TABLE alert_notices (alert_id INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (alert_id, kind)) WITHOUT ROWID;
        INSERT INTO alert_notices (alert_id, kind) SELECT id, 'started' FROM alerts;
        INSERT INTO alert_notices (alert_id, kind) SELECT id, 'ended' FROM alerts WHERE name IN ('Ended', 'Ended a short time ago');
      `);
      return db;
    }

    const resolvedFlags = (store: AlertStore) => store.read(allAlertsQuery)
      .map(({ name, resolved }) => ({ name, resolved }))
      .sort((first, second) => first.name.localeCompare(second.name));

    it('marks the alerts that ended more than the grace time before the update as resolved', () => {
      const updated = new AlertStore(oldDatabase(), NOW);

      expect(resolvedFlags(updated)).toEqual([
        { name: 'Ended', resolved: true },
        { name: 'Firing', resolved: false },
      ]);
    });

    it('marks only the alerts with an "ended" note as resolved when the older version had notifications', () => {
      // An update can take more than the grace time. An alert with no "ended" note fired when the older version stopped.
      const updated = new AlertStore(oldDatabaseWithNotes(), NOW);

      expect(resolvedFlags(updated)).toEqual([
        { name: 'Ended', resolved: true },
        { name: 'Ended a short time ago', resolved: true },
        { name: 'Firing', resolved: false },
        { name: 'Firing for a long update', resolved: false },
      ]);
    });

    it('changes nothing at the next start', () => {
      const db = oldDatabase();
      new AlertStore(db, NOW);
      db.prepare("UPDATE alerts SET resolved = 0 WHERE name = 'Ended'").run();
      new AlertStore(db, NOW + 10 * MINUTE_MS);

      expect(new AlertStore(db, NOW).read(allAlertsQuery).map(found => found.resolved)).toEqual([false, false]);
    });
  });

  describe('updateFromVmalert', () => {
    const labels = { alertgroup: 'machine-m1', alertname: 'In alarm', machine: 'm1' };
    /** The alert was sent last at NOW - 2 minutes, so its end time passed */
    const lapsed = anAlert({ name: 'In alarm', labels, startsAt: NOW - 5 * MINUTE_MS, endsAt: NOW - 2 * MINUTE_MS + VMALERT_LEASE_MS });
    const checkedAfterLastSend = new Map([['machine-m1\nIn alarm', NOW - 10_000]]);

    function state(values: Partial<VmalertState> = {}): VmalertState {
      return { firing: [], lastChecks: new Map(), ...values };
    }

    it('gives a new end time to an alert that still fires in vmalert, with the labels in any order', () => {
      store.save([lapsed], NOW - 2 * MINUTE_MS);

      const result = store.updateFromVmalert(state({ firing: [{ labels: { machine: 'm1', alertname: 'In alarm', alertgroup: 'machine-m1' } }] }), NOW);

      expect(result).toEqual({ renewed: 1, ended: 0 });
      expect(store.read(allAlertsQuery)).toMatchObject([{ endsAt: NOW + VMALERT_LEASE_MS, resolved: false }]);
    });

    it('does not make the end time of a firing alert earlier', () => {
      store.save([anAlert({ labels, endsAt: NOW + 2 * VMALERT_LEASE_MS })], NOW);

      store.updateFromVmalert(state({ firing: [{ labels }] }), NOW);

      expect(store.read(allAlertsQuery)).toMatchObject([{ endsAt: NOW + 2 * VMALERT_LEASE_MS }]);
    });

    it('resolves an alert that vmalert checked after the last send and does not have any more', () => {
      store.save([lapsed], NOW - 2 * MINUTE_MS);

      const result = store.updateFromVmalert(state({ lastChecks: checkedAfterLastSend }), NOW);

      expect(result).toEqual({ renewed: 0, ended: 1 });
      expect(store.read(allAlertsQuery)).toMatchObject([{ endsAt: lapsed.endsAt, resolved: true }]);
    });

    it('resolves a gone alert with an end time in the future at the time of the update', () => {
      store.save([anAlert({ labels, endsAt: NOW + 30_000 })], NOW - 30_000);

      store.updateFromVmalert(state({ lastChecks: new Map([['machine-m1\nIn alarm', NOW - 5_000]]) }), NOW);

      expect(store.read(allAlertsQuery)).toMatchObject([{ endsAt: NOW, resolved: true }]);
    });

    it('changes nothing when vmalert did not check the rule after the last send, for example just after a restart of vmalert', () => {
      store.save([lapsed], NOW - 2 * MINUTE_MS);
      const checkedBeforeLastSend = new Map([['machine-m1\nIn alarm', lapsed.endsAt - VMALERT_LEASE_MS]]);

      expect(store.updateFromVmalert(state({ lastChecks: checkedBeforeLastSend }), NOW)).toEqual({ renewed: 0, ended: 0 });
      expect(store.updateFromVmalert(state(), NOW)).toEqual({ renewed: 0, ended: 0 });
      expect(store.read(allAlertsQuery)).toMatchObject([{ resolved: false }]);
    });

    it('changes no alert that already ended', () => {
      store.save([anAlert({ labels, endsAt: NOW - MINUTE_MS, resolved: true })], NOW);

      expect(store.updateFromVmalert(state({ firing: [{ labels }] }), NOW)).toEqual({ renewed: 0, ended: 0 });
      expect(store.read(allAlertsQuery)).toMatchObject([{ endsAt: NOW - MINUTE_MS, resolved: true }]);
    });
  });
});
