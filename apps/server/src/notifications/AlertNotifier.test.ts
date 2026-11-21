import type { NotificationChannel } from '@local-chatter/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Alert } from '../alerts/AlertStore.js';
import type { AlertChange } from './AlertChangeFinder.js';
import { AlertNotifier } from './AlertNotifier.js';
import { Outbox, SEND_LIMIT } from './Outbox.js';
import { moreAlertsMessage } from './outgoingMessages.js';

const NOW = Date.UTC(2026, 10, 13, 15, 2);
const OPTIONS = { timeZone: 'America/Chicago', linkBaseUrl: null };

function anAlert(values: Partial<Alert> = {}): Alert {
  return {
    name: 'In alarm', machineId: 'haas-vf2', labels: { alertname: 'In alarm', machine: 'haas-vf2', severity: 'critical' },
    annotations: {}, startsAt: NOW, endsAt: NOW + 60_000, ...values,
  };
}

function channel(id: string, values: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id, type: 'webhook', name: id, settings: {}, hasSecret: {}, minSeverity: 'warning', machineIds: null, ignorePatterns: [], enabled: true,
    createdAt: '2026-11-13T09:00:00.000Z', ...values,
  };
}

function change(kind: 'started' | 'ended', alert = anAlert(), alertId = 1): AlertChange {
  return { kind, alertId, alert, at: kind === 'started' ? alert.startsAt : alert.endsAt };
}

describe('AlertNotifier', () => {
  let outbox: Outbox;
  let channels: NotificationChannel[];
  let notifier: AlertNotifier;

  beforeEach(() => {
    outbox = new Outbox(new Database(':memory:'), count => moreAlertsMessage(count, OPTIONS));
    channels = [];
    notifier = new AlertNotifier({
      channels: { list: () => channels },
      outbox,
      machineName: id => (id === 'haas-vf2' ? 'Haas VF-2' : null),
      textOptions: () => OPTIONS,
      now: () => NOW,
    });
  });

  function texts(entries: { message: { text: string } }[]): string[] {
    return entries.map(entry => entry.message.text);
  }

  function queued(): string[] {
    return outbox.list({}).reverse().map(message => `${message.channelId} ${message.kind}: ${message.text}`);
  }

  it('queues a start message for each channel that wants the alert', () => {
    channels = [channel('phones'), channel('slack')];

    notifier.alertChanged(change('started'));

    expect(queued()).toEqual([
      'phones started: CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.',
      'slack started: CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.',
    ]);
    expect(outbox.list({})[0]).toMatchObject({ alertId: 1, machineId: 'haas-vf2', severity: 'critical' });
  });

  it('sends nothing to a channel that is off, that wants a higher level, or that wants other machines', () => {
    channels = [
      channel('off', { enabled: false }),
      channel('critical-only', { minSeverity: 'critical' }),
      channel('other-machine', { machineIds: ['haas-st10'] }),
    ];

    notifier.alertChanged(change('started', anAlert({ labels: { alertname: 'In alarm', severity: 'warning' } })));

    expect(queued()).toEqual([]);
  });

  it('turns a start message that still waits into one combined message when the alert ends', () => {
    channels = [channel('phones')];

    notifier.alertChanged(change('started'));
    notifier.alertChanged(change('ended'));

    expect(queued()).toEqual(['phones combined: CRITICAL - Haas VF-2: In alarm started 9:02 AM and ended 9:03 AM.']);
  });

  it('queues an end message when the start message already went', () => {
    channels = [channel('phones')];
    notifier.alertChanged(change('started'));
    const [start] = outbox.takeDue(NOW);
    outbox.markSent(start.id, 'Sent', NOW);

    notifier.alertChanged(change('ended'));

    expect(queued()).toEqual([
      'phones started: CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.',
      'phones ended: OK - Haas VF-2: In alarm ended at 9:03 AM.',
    ]);
  });

  it('sends no end message to a channel that did not get the start message, for example a channel added during the alert', () => {
    channels = [channel('phones')];
    notifier.alertChanged(change('started'));
    channels = [channel('phones'), channel('added-later')];
    const [start] = outbox.takeDue(NOW);
    outbox.markSent(start.id, 'Sent', NOW);

    notifier.alertChanged(change('ended'));

    expect(queued()).toEqual([
      'phones started: CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.',
      'phones ended: OK - Haas VF-2: In alarm ended at 9:03 AM.',
    ]);
  });

  it('sends no end message when no channel got the start message, for example an alert that was on before the update', () => {
    channels = [channel('phones')];

    notifier.alertChanged(change('ended'));

    expect(queued()).toEqual([]);
  });

  describe('ignore patterns', () => {
    function statuses(): string[] {
      return outbox.list({}).reverse().map(message => `${message.channelId} ${message.kind} ${message.status}: ${message.detail}`);
    }

    function sendWaiting(): void {
      for (const entry of outbox.takeDue(NOW)) outbox.markSent(entry.id, 'Sent', NOW);
    }

    it('does not send a start message whose text matches a pattern of the channel, and keeps it as ignored', () => {
      channels = [channel('phones', { ignorePatterns: ['Program 9', 'haas vf-2: in*'] }), channel('slack')];

      notifier.alertChanged(change('started'));

      expect(statuses()).toEqual([
        'phones started ignored: Ignored by the pattern "haas vf-2: in*"',
        'slack started waiting: null',
      ]);
    });

    it('ignores the end of an alert whose start was ignored, also when the end text does not match', () => {
      channels = [channel('phones', { ignorePatterns: ['Started 9:02'] })];
      notifier.alertChanged(change('started'));

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual([
        'phones started ignored: Ignored by the pattern "Started 9:02"',
        'phones ended ignored: Ignored, because the start of this alert was ignored',
      ]);
      expect(outbox.takeDue(NOW)).toEqual([]);
    });

    it('checks only the start text for a combined message, so a pattern for end messages does not drop a waiting start', () => {
      channels = [channel('phones', { ignorePatterns: ['ended 9:03'] })];
      notifier.alertChanged(change('started'));

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual(['phones combined waiting: null']);
    });

    it('turns a waiting start into one ignored combined message when the start text matches a pattern added since', () => {
      channels = [channel('phones')];
      notifier.alertChanged(change('started'));
      channels = [channel('phones', { ignorePatterns: ['In alarm'] })];

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual(['phones combined ignored: Ignored by the pattern "In alarm"']);
      expect(outbox.takeDue(NOW)).toEqual([]);
    });

    it('combines a waiting start as before when the combined text does not match', () => {
      channels = [channel('phones', { ignorePatterns: ['Program 9'] })];
      notifier.alertChanged(change('started'));

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual(['phones combined waiting: null']);
    });

    it('ignores the end of an alert whose start was sent, when the end text matches', () => {
      channels = [channel('phones', { ignorePatterns: ['ended at'] })];
      notifier.alertChanged(change('started'));
      sendWaiting();

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual([
        'phones started sent: Sent',
        'phones ended ignored: Ignored by the pattern "ended at"',
      ]);
    });

    it('sends the end of an alert whose start was sent, when the end text does not match', () => {
      channels = [channel('phones', { ignorePatterns: ['Program 9'] })];
      notifier.alertChanged(change('started'));
      sendWaiting();

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual(['phones started sent: Sent', 'phones ended waiting: null']);
    });

    it('checks the end text alone when the start is being sent', () => {
      channels = [channel('phones', { ignorePatterns: ['ended at'] })];
      notifier.alertChanged(change('started'));
      outbox.takeDue(NOW);

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual([
        'phones started waiting: null',
        'phones ended ignored: Ignored by the pattern "ended at"',
      ]);
    });

    function endOfAlert1(): unknown {
      return outbox.list({}).find(message => message.alertId === 1 && message.kind === 'ended');
    }

    it('checks the end text alone when the start failed, and ignores a matching end', () => {
      channels = [channel('phones', { ignorePatterns: ['ended at'] })];
      notifier.alertChanged(change('started'));
      const [start] = outbox.takeDue(NOW);
      outbox.markFailed(start.id, 'Twilio refused the login.');

      notifier.alertChanged(change('ended'));

      expect(outbox.startStatus('phones', 1)).toBe('failed');
      expect(endOfAlert1()).toMatchObject({ status: 'ignored', detail: 'Ignored by the pattern "ended at"' });
    });

    it('checks the end text alone when the start went into a "more" message, and ignores a matching end', () => {
      channels = [channel('phones', { ignorePatterns: ['ended at'] })];
      for (let alertId = 100; alertId < 100 + SEND_LIMIT - 1; alertId += 1) {
        notifier.alertChanged(change('started', anAlert(), alertId));
        sendWaiting();
      }
      notifier.alertChanged(change('started', anAlert(), 1));
      notifier.alertChanged(change('started', anAlert(), 2));
      outbox.takeDue(NOW);

      notifier.alertChanged(change('ended'));

      expect(outbox.startStatus('phones', 1)).toBe('grouped');
      expect(endOfAlert1()).toMatchObject({ status: 'ignored', detail: 'Ignored by the pattern "ended at"' });
    });

    it('sends no end message, not even an ignored one, when the channel did not get the start', () => {
      channels = [channel('phones', { ignorePatterns: ['OK'] })];

      notifier.alertChanged(change('ended'));

      expect(statuses()).toEqual([]);
    });
  });

  describe('an event alert, such as "program ended"', () => {
    const programEnded = anAlert({
      name: 'Program ended',
      labels: { alertname: 'Program ended', machine: 'haas-vf2', severity: 'warning', event: 'true' },
    });

    it('sends the start message, and no end message when the alert clears', () => {
      channels = [channel('phones')];
      notifier.alertChanged(change('started', programEnded));
      const [start] = outbox.takeDue(NOW);
      outbox.markSent(start.id, 'Sent', NOW);

      notifier.alertChanged(change('ended', programEnded));

      expect(queued()).toEqual(['phones started: WARNING - Haas VF-2: Program ended. Started 9:02 AM.']);
    });

    it('waits when the channel is at its limit, like each other alert, so a busy shop cannot use the limit of the service', () => {
      channels = [channel('phones')];
      for (let alertId = 100; alertId < 100 + SEND_LIMIT; alertId += 1) {
        notifier.alertChanged(change('started', anAlert(), alertId));
        for (const entry of outbox.takeDue(NOW)) outbox.markSent(entry.id, 'Sent', NOW);
      }

      notifier.alertChanged(change('started', programEnded, 1));

      expect(texts(outbox.takeDue(NOW))).toEqual([]);
    });

    it('keeps an ignored event start as ignored, and adds nothing when the alert clears', () => {
      channels = [channel('phones', { ignorePatterns: ['Program ended'] })];

      notifier.alertChanged(change('started', programEnded));
      notifier.alertChanged(change('ended', programEnded));

      expect(outbox.list({}).map(({ kind, status, detail }) => ({ kind, status, detail }))).toEqual([
        { kind: 'started', status: 'ignored', detail: 'Ignored by the pattern "Program ended"' },
      ]);
    });

    it('does not combine a start that still waits: the start goes as it is', () => {
      channels = [channel('phones')];

      notifier.alertChanged(change('started', programEnded));
      notifier.alertChanged(change('ended', programEnded));

      expect(queued()).toEqual(['phones started: WARNING - Haas VF-2: Program ended. Started 9:02 AM.']);
    });
  });

  it('sends an alert that is not about one machine only to the channels for all machines', () => {
    channels = [channel('all'), channel('one-machine', { machineIds: ['haas-vf2'] })];

    notifier.alertChanged(change('started', anAlert({ machineId: undefined, labels: { alertname: 'In alarm', severity: 'critical' } })));

    expect(queued()).toEqual(['all started: CRITICAL - Chatter: In alarm. Started 9:02 AM.']);
  });

  it('logs an error and goes on when the messages of a change cannot be queued, so later alerts still get theirs', () => {
    channels = [channel('phones')];
    const failing = new AlertNotifier({
      channels: { list: () => channels }, outbox, textOptions: () => OPTIONS, now: () => NOW,
      machineName: id => { if (id === 'broken') throw new Error('no name'); return 'Haas VF-2'; },
    });

    expect(() => failing.alertChanged(change('started', anAlert({ machineId: 'broken' }), 1))).not.toThrow();
    failing.alertChanged(change('started', anAlert(), 2));

    expect(queued()).toEqual(['phones started: CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.']);
  });

  it('treats an alert with an unknown severity as a warning, so a warning channel still gets it', () => {
    channels = [channel('warning'), channel('critical', { minSeverity: 'critical' })];

    notifier.alertChanged(change('started', anAlert({ labels: { alertname: 'In alarm', machine: 'haas-vf2' } })));

    expect(queued()).toEqual(['warning started: ALERT - Haas VF-2: In alarm. Started 9:02 AM.']);
  });
});
