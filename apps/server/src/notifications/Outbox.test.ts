import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OutgoingMessage } from './channels/ChannelType.js';
import { BACKLOG_SEND, EVENT_REPEAT_MS, MAX_KEPT_MESSAGES, Outbox, type OutboxEntry, SEND_LIMIT, SEND_LIMIT_WINDOW_MS } from './Outbox.js';

const NOW = Date.UTC(2026, 10, 13, 9, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function alertMessage(kind: 'started' | 'ended' | 'combined', machineId = 'haas-vf2'): OutgoingMessage {
  return {
    kind, text: `${kind} - Haas VF-2: In alarm`, severity: 'critical', machine: { id: machineId, name: 'Haas VF-2' },
    alertName: 'In alarm', summary: 'In alarm', startedAt: '2026-11-13T09:00:00.000Z', endedAt: null, link: null,
  };
}

function moreAlerts(count: number): OutgoingMessage {
  return {
    kind: 'more', text: `And ${count} more alerts.`, severity: null, machine: null,
    alertName: null, summary: null, startedAt: null, endedAt: null, link: null,
  };
}

describe('Outbox', () => {
  let db: Database.Database;
  let outbox: Outbox;

  beforeEach(() => {
    db = new Database(':memory:');
    outbox = new Outbox(db, moreAlerts);
  });

  function queue(channelId: string, alertId: number | null, message = alertMessage('started'), now = NOW): number {
    return outbox.queue({ channelId, alertId, message }, now);
  }

  /** Queues and sends `count` messages, the first at `now`, and each next one `gap` later */
  function sendMessages(channelId: string, count: number, now: number, gap = 0): void {
    for (let index = 0; index < count; index += 1) {
      const time = now + index * gap;
      const id = queue(channelId, null, alertMessage('started'), time);
      if (!outbox.takeDue(time).some(entry => entry.id === id)) throw new Error(`Message ${id} was not due`);
      outbox.markSent(id, 'Sent to 1 phone', time);
    }
  }

  function texts(entries: OutboxEntry[]): string[] {
    return entries.map(entry => entry.message.text);
  }

  it('keeps the result of a test in the list, and never gives the test to the sender', () => {
    const test = { ...moreAlerts(0), kind: 'test' as const, text: 'Test from Chatter.' };

    outbox.keepTestResult('phones', test, { ok: true, detail: 'Sent to 1 phone' }, NOW);
    outbox.keepTestResult('slack', test, { ok: false, error: 'Slack says the address is wrong.' }, NOW);

    expect(outbox.takeDue(NOW)).toEqual([]);
    expect(outbox.list({}).map(({ channelId, kind, status, detail, lastError }) => ({ channelId, kind, status, detail, lastError }))).toEqual([
      { channelId: 'slack', kind: 'test', status: 'failed', detail: null, lastError: 'Slack says the address is wrong.' },
      { channelId: 'phones', kind: 'test', status: 'sent', detail: 'Sent to 1 phone', lastError: null },
    ]);
  });

  it('gives a queued message to the sender, and shows it as waiting', () => {
    const id = queue('phones', 7);

    expect(outbox.takeDue(NOW)).toEqual([{ id, channelId: 'phones', message: alertMessage('started'), attempts: 0, createdAt: NOW }]);
    expect(outbox.list({})).toEqual([{
      id, channelId: 'phones', alertId: 7, kind: 'started', machineId: 'haas-vf2', severity: 'critical',
      text: 'started - Haas VF-2: In alarm', status: 'waiting', attempts: 0, lastError: null, detail: null,
      createdAt: '2026-11-13T09:00:00.000Z', sentAt: null,
    }]);
  });

  it('gives at most one message for each channel, the oldest first', () => {
    queue('phones', 1, alertMessage('started'));
    queue('phones', 2, alertMessage('ended'));
    queue('slack', 3, alertMessage('combined'));

    expect(texts(outbox.takeDue(NOW)).sort()).toEqual(['combined - Haas VF-2: In alarm', 'started - Haas VF-2: In alarm']);
  });

  it('does not give the next message of a channel while its message is being sent', () => {
    queue('phones', 1, alertMessage('started'));
    queue('phones', 2, alertMessage('ended'));
    const [first] = outbox.takeDue(NOW);

    expect(outbox.takeDue(NOW)).toEqual([]);

    outbox.markSent(first.id, 'Sent to 1 phone', NOW);
    expect(texts(outbox.takeDue(NOW))).toEqual(['ended - Haas VF-2: In alarm']);
  });

  it('marks a sent message, with the time and what the service said', () => {
    const id = queue('phones', 1);
    outbox.takeDue(NOW);

    outbox.markSent(id, 'Sent to 2 phones', NOW + 5_000);

    expect(outbox.list({})[0]).toMatchObject({
      status: 'sent', attempts: 1, detail: 'Sent to 2 phones', sentAt: '2026-11-13T09:00:05.000Z',
    });
    expect(outbox.takeDue(NOW + 5_000)).toEqual([]);
  });

  it('gives a message again at the time of its next try, and keeps the next messages of the channel behind it', () => {
    const id = queue('phones', 1, alertMessage('started'));
    queue('phones', 2, alertMessage('ended'));
    outbox.takeDue(NOW);

    outbox.markRetry(id, 'Twilio answered 503.', NOW + 30_000);

    expect(outbox.takeDue(NOW + 29_999)).toEqual([]);
    expect(outbox.takeDue(NOW + 30_000)).toEqual([expect.objectContaining({ id, attempts: 1 })]);
    expect(outbox.list({}).find(message => message.id === id)).toMatchObject({ status: 'waiting', lastError: 'Twilio answered 503.' });
  });

  it('marks a message that failed, and then gives the next message of the channel', () => {
    const id = queue('phones', 1, alertMessage('started'));
    queue('phones', 2, alertMessage('ended'));
    outbox.takeDue(NOW);

    outbox.markFailed(id, 'Twilio refused the login.');

    expect(outbox.list({}).find(message => message.id === id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'Twilio refused the login.' });
    expect(texts(outbox.takeDue(NOW))).toEqual(['ended - Haas VF-2: In alarm']);
  });

  describe('the hold of a channel', () => {
    it('holds the channel after a failed message, until the time of the hold, and not the other channels', () => {
      const id = queue('phones', 1);
      outbox.takeDue(NOW);

      outbox.markFailed(id, 'ntfy: the limit is used.', NOW + 60 * MINUTE);
      queue('phones', 2);
      queue('slack', 3);

      expect(outbox.takeDue(NOW).map(entry => entry.channelId)).toEqual(['slack']);
      expect(outbox.takeDue(NOW + 60 * MINUTE).map(entry => entry.channelId)).toEqual(['phones']);
    });

    it('keeps the longer hold when a shorter one comes', () => {
      const first = queue('phones', 1);
      outbox.takeDue(NOW);
      outbox.markFailed(first, 'ntfy: the limit is used.', NOW + 60 * MINUTE);
      const second = queue('phones', 2);
      outbox.takeDue(NOW + 60 * MINUTE);

      outbox.markRetry(second, 'ntfy answered 503.', NOW + 61 * MINUTE);
      outbox.markFailed(second, 'ntfy answered 503.', NOW + 30 * MINUTE);
      queue('phones', 3);

      expect(outbox.takeDue(NOW + 61 * MINUTE - 1)).toEqual([]);
      expect(outbox.takeDue(NOW + 61 * MINUTE)).toHaveLength(1);
    });

    it('ends the hold when a message to the channel goes, for example a test', () => {
      const id = queue('phones', 1);
      outbox.takeDue(NOW);
      outbox.markFailed(id, 'ntfy: the limit is used.', NOW + 60 * MINUTE);
      queue('phones', 2);

      outbox.keepTestResult('phones', { ...moreAlerts(0), kind: 'test', text: 'Test from Chatter.' }, { ok: true, detail: 'ntfy sent it' }, NOW);

      expect(outbox.takeDue(NOW)).toHaveLength(1);
    });

    it('ends the hold of a removed channel', () => {
      const id = queue('phones', 1);
      outbox.takeDue(NOW);
      outbox.markFailed(id, 'ntfy: the limit is used.', NOW + 60 * MINUTE);

      outbox.removeChannel('phones');

      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_channel_holds').get()).toEqual({ count: 0 });
    });
  });

  describe('the messages that waited while the channel was held', () => {
    function named(alertName: string, machineName: string, kind: 'started' | 'ended' = 'started'): OutgoingMessage {
      return { ...alertMessage(kind, machineName.toLowerCase()), alertName, machine: { id: machineName.toLowerCase(), name: machineName }, text: `${kind} ${alertName}` };
    }

    /** The first message fails and holds the channel for one hour. Then `waiting` more messages come. */
    function holdWith(waiting: OutgoingMessage[]): number {
      const first = queue('phones', 1, named('In alarm', 'Haas VF-2'));
      outbox.takeDue(NOW);
      outbox.markRetry(first, 'ntfy: the limit is used.', NOW + 60 * MINUTE);
      waiting.forEach((message, index) => queue('phones', 10 + index, message, NOW + index * MINUTE));
      return first;
    }

    function status(id: number) {
      return outbox.list({}).find(message => message.id === id);
    }

    it(`sends one summary message and then only the newest ${BACKLOG_SEND}, when the hold ends`, () => {
      const first = holdWith([
        named('Program ended', 'Haas ST-10'), named('Program ended', 'Haas ST-10'), named('Program ended', 'Haas ST-10'),
        named('In alarm', 'Haas VF-2'), named('Idle', 'Haas VF-2'), named('Idle', 'Haas ST-10'), named('Spindle load', 'Haas VF-2'),
      ]);

      const [summary] = outbox.takeDue(NOW + 60 * MINUTE);

      expect(summary.message).toMatchObject({ kind: 'more', machine: null });
      expect(summary.message.text).toBe(
        'Chatter could not send 5 alerts while the channel was blocked: Program ended on Haas ST-10 (3), In alarm on Haas VF-2 (2). Open Chatter to see them.',
      );
      expect(status(first)).toMatchObject({
        status: 'grouped', lastError: 'ntfy: the limit is used.',
        detail: 'In one summary message, because the service did not take messages for a time.',
      });
      outbox.markSent(summary.id, 'ntfy sent it', NOW + 60 * MINUTE);
      const sent: string[] = [];
      for (let entry = outbox.takeDue(NOW + 60 * MINUTE)[0]; entry; entry = outbox.takeDue(NOW + 60 * MINUTE)[0]) {
        sent.push(entry.message.text);
        outbox.markSent(entry.id, 'ntfy sent it', NOW + 60 * MINUTE);
      }
      expect(sent).toEqual(['started Idle', 'started Idle', 'started Spindle load']);
      expect(outbox.list({}).filter(message => message.status === 'grouped')).toHaveLength(5);
    });

    it('counts the start and the end of one alert one time, and adds the alerts of a "more" message', () => {
      const more = moreAlerts(4);
      holdWith([named('Idle', 'Haas VF-2'), more, named('A', 'M'), named('B', 'M'), named('C', 'M')]);
      queue('phones', 1, named('In alarm', 'Haas VF-2', 'ended'), NOW + 30 * MINUTE);
      db.prepare("UPDATE notification_messages SET alert_count = 4 WHERE kind = 'more'").run();

      // Kept: B, C and the end of alert 1. The summary has alert 1 (its start), Idle, the 4 alerts of "more", and A.
      expect(outbox.takeDue(NOW + 60 * MINUTE)[0].message.text).toBe(
        'Chatter could not send 7 alerts while the channel was blocked: A on M (1), Idle on Haas VF-2 (1), In alarm on Haas VF-2 (1), other alerts (4). '
        + 'Open Chatter to see them.',
      );
    });

    it(`sends each message, when no more than ${BACKLOG_SEND + 1} wait after the hold`, () => {
      holdWith([named('A', 'M'), named('B', 'M'), named('C', 'M')]);

      expect(texts(outbox.takeDue(NOW + 60 * MINUTE))).toEqual(['started In alarm']);
    });

    it('makes no summary message for a channel that was not held', () => {
      Array.from({ length: 8 }, (_, index) => queue('phones', index, named(`Alarm ${index}`, 'M')));

      expect(texts(outbox.takeDue(NOW))).toEqual(['started Alarm 0']);
    });

    it('does not put a test message in the summary message', () => {
      const test = queue('phones', null, { ...moreAlerts(0), kind: 'test', text: 'Test from Chatter.' }, NOW);
      holdWith([named('A', 'M'), named('B', 'M'), named('C', 'M'), named('D', 'M'), named('E', 'M')]);

      outbox.takeDue(NOW + 60 * MINUTE);

      expect(status(test)?.status).toBe('waiting');
    });
  });

  it('gives a message again after a restart, when Chatter stopped while it was sending the message', () => {
    const id = queue('phones', 1);
    outbox.takeDue(NOW);

    const afterRestart = new Outbox(db, moreAlerts);

    expect(afterRestart.takeDue(NOW)).toEqual([expect.objectContaining({ id })]);
  });

  describe('combineWithWaitingStart', () => {
    it('changes a waiting start message into one message that tells the start and the end', () => {
      const id = queue('phones', 7, alertMessage('started'));

      expect(outbox.combineWithWaitingStart('phones', 7, alertMessage('combined'))).toBe(true);

      expect(outbox.list({})).toEqual([expect.objectContaining({ id, kind: 'combined', text: 'combined - Haas VF-2: In alarm' })]);
      expect(outbox.takeDue(NOW)[0].message).toEqual(alertMessage('combined'));
    });

    it('does not change a start message that was sent, or that is being sent', () => {
      const sent = queue('phones', 7);
      outbox.takeDue(NOW);
      outbox.markSent(sent, 'Sent to 1 phone', NOW);
      queue('slack', 8);
      outbox.takeDue(NOW);

      expect(outbox.combineWithWaitingStart('phones', 7, alertMessage('combined'))).toBe(false);
      expect(outbox.combineWithWaitingStart('slack', 8, alertMessage('combined'))).toBe(false);
    });

    it('changes only the start message of that channel and that alert', () => {
      queue('phones', 7);

      expect(outbox.combineWithWaitingStart('slack', 7, alertMessage('combined'))).toBe(false);
      expect(outbox.combineWithWaitingStart('phones', 8, alertMessage('combined'))).toBe(false);
    });
  });

  describe('startStatus', () => {
    it('gives the status of the start message of the alert on the channel', () => {
      queue('waiting', 1);
      const failed = queue('failed', 1);
      outbox.takeDue(NOW);
      outbox.markFailed(failed, 'Twilio refused the login.');
      outbox.keepIgnored({ channelId: 'ignored', alertId: 1, message: alertMessage('started') }, 'Ignored by the pattern "alarm"', NOW);
      sendMessages('grouped', SEND_LIMIT - 1, NOW);
      [1, 2].forEach(alertId => queue('grouped', alertId, alertMessage('started'), NOW + MINUTE));
      outbox.takeDue(NOW + MINUTE);

      expect(outbox.startStatus('waiting', 1)).toBe('waiting');
      expect(outbox.startStatus('failed', 1)).toBe('failed');
      expect(outbox.startStatus('ignored', 1)).toBe('ignored');
      expect(outbox.startStatus('grouped', 1)).toBe('grouped');
    });

    it('is null for another channel or another alert', () => {
      queue('phones', 1);

      expect(outbox.startStatus('slack', 1)).toBeNull();
      expect(outbox.startStatus('phones', 2)).toBeNull();
    });
  });

  describe('ignored messages', () => {
    const IGNORED = 'Ignored by the pattern "alarm"';

    function keepIgnored(channelId: string, alertId: number, message = alertMessage('started'), now = NOW): void {
      outbox.keepIgnored({ channelId, alertId, message }, IGNORED, now);
    }

    it('keeps an ignored message in the list, with the reason', () => {
      keepIgnored('phones', 7);

      expect(outbox.list({})).toEqual([expect.objectContaining({
        channelId: 'phones', alertId: 7, kind: 'started', status: 'ignored', detail: IGNORED, attempts: 0, sentAt: null,
      })]);
    });

    it('never gives an ignored message to the sender', () => {
      keepIgnored('phones', 7);
      const next = queue('phones', 8);

      expect(outbox.takeDue(NOW).map(entry => entry.id)).toEqual([next]);
    });

    it('does not count an ignored message in the limit of the channel', () => {
      sendMessages('phones', SEND_LIMIT - 2, NOW);
      for (let alertId = 1; alertId <= 5; alertId += 1) keepIgnored('phones', alertId);
      queue('phones', 6, alertMessage('started'), NOW + MINUTE);
      queue('phones', 7, alertMessage('started'), NOW + MINUTE);

      expect(outbox.takeDue(NOW + MINUTE)).toEqual([expect.objectContaining({ message: alertMessage('started') })]);
    });

    it('never puts an ignored message into a "more" message', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      keepIgnored('phones', 1, alertMessage('started'), NOW + MINUTE);
      [2, 3].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));

      expect(outbox.takeDue(NOW + MINUTE)[0].message).toEqual(moreAlerts(2));
      expect(outbox.list({}).find(message => message.alertId === 1)).toMatchObject({ status: 'ignored', detail: IGNORED });
    });

    it('deletes old ignored messages like the other finished messages', () => {
      keepIgnored('phones', 1, alertMessage('started'), NOW - 31 * DAY);

      outbox.cleanUp(NOW);

      expect(outbox.list({})).toEqual([]);
    });

    it('turns a waiting start message into an ignored combined message', () => {
      const id = queue('phones', 7, alertMessage('started'));

      expect(outbox.combineWithWaitingStart('phones', 7, alertMessage('combined'), IGNORED)).toBe(true);

      expect(outbox.list({})).toEqual([expect.objectContaining({ id, kind: 'combined', status: 'ignored', detail: IGNORED })]);
      expect(outbox.takeDue(NOW)).toEqual([]);
    });
  });

  describe(`the limit of ${SEND_LIMIT} messages in 10 minutes`, () => {
    it('holds the messages of a channel at its limit, until the oldest sent message is 10 minutes old', () => {
      sendMessages('phones', SEND_LIMIT, NOW);
      queue('phones', 1, alertMessage('ended'), NOW + MINUTE);
      queue('slack', 2, alertMessage('combined'), NOW + MINUTE);

      expect(texts(outbox.takeDue(NOW + MINUTE))).toEqual(['combined - Haas VF-2: In alarm']);
      expect(outbox.takeDue(NOW + SEND_LIMIT_WINDOW_MS - 1)).toEqual([]);
      expect(texts(outbox.takeDue(NOW + SEND_LIMIT_WINDOW_MS))).toEqual(['ended - Haas VF-2: In alarm']);
    });

    it('sends one "more" message in place of the waiting messages, when the channel has room for only one message', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      const waiting = [1, 2, 3].map(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));

      const due = outbox.takeDue(NOW + MINUTE);

      expect(due).toEqual([expect.objectContaining({ channelId: 'phones', message: moreAlerts(3), attempts: 0 })]);
      const listed = outbox.list({});
      expect(listed.filter(message => waiting.includes(message.id))).toEqual(waiting.map(() => expect.objectContaining({
        status: 'grouped', detail: `Grouped with 2 more messages, because a channel gets at most ${SEND_LIMIT} messages in 10 minutes.`,
      })));
      expect(listed[0]).toMatchObject({ id: due[0].id, kind: 'more', status: 'waiting', alertId: null, machineId: null });
    });

    it('says "message" when one other message went in the "more" message', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      [1, 2].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));

      outbox.takeDue(NOW + MINUTE);

      expect(outbox.list({}).find(message => message.alertId === 1)?.detail)
        .toBe(`Grouped with 1 more message, because a channel gets at most ${SEND_LIMIT} messages in 10 minutes.`);
    });

    it('keeps sending each message as it is while the channel has room for two or more', () => {
      sendMessages('phones', SEND_LIMIT - 2, NOW);
      [1, 2, 3].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));

      expect(outbox.takeDue(NOW + MINUTE)).toEqual([expect.objectContaining({ message: alertMessage('started') })]);
    });

    it('counts the start and the end of one alert as one alert', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      queue('phones', 1, alertMessage('started'), NOW + MINUTE);
      queue('phones', 2, alertMessage('started'), NOW + MINUTE);
      queue('phones', 1, alertMessage('ended'), NOW + MINUTE);

      expect(outbox.takeDue(NOW + MINUTE)[0].message).toEqual(moreAlerts(2));
    });

    it('adds the alerts of a "more" message that waits to the next "more" message', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      [1, 2, 3].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));
      const [more] = outbox.takeDue(NOW + MINUTE);
      outbox.markRetry(more.id, 'Twilio answered 503.', NOW + 2 * MINUTE);
      [4, 5].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + 2 * MINUTE));

      expect(outbox.takeDue(NOW + 2 * MINUTE)[0].message).toEqual(moreAlerts(5));
    });

    it('does not put a test message into a "more" message', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      const test = queue('phones', null, { ...moreAlerts(0), kind: 'test', text: 'Test from Chatter.' }, NOW + MINUTE);
      [1, 2].forEach(alertId => queue('phones', alertId, alertMessage('started'), NOW + MINUTE));

      expect(outbox.takeDue(NOW + MINUTE)[0].message).toEqual(moreAlerts(2));
      expect(outbox.list({}).find(message => message.id === test)?.status).toBe('waiting');
    });

    it('sends the last message as it is, when only one message waits', () => {
      sendMessages('phones', SEND_LIMIT - 1, NOW);
      queue('phones', 1, alertMessage('ended'), NOW + MINUTE);

      expect(texts(outbox.takeDue(NOW + MINUTE))).toEqual(['ended - Haas VF-2: In alarm']);
    });

    it('does not count the messages that failed', () => {
      for (let index = 0; index < SEND_LIMIT; index += 1) {
        const id = queue('phones', index);
        outbox.takeDue(NOW);
        outbox.markFailed(id, 'Twilio refused the login.');
      }
      queue('phones', 99, alertMessage('ended'));

      expect(texts(outbox.takeDue(NOW))).toEqual(['ended - Haas VF-2: In alarm']);
    });
  });

  describe('event messages, such as "program ended"', () => {
    const LINK = 'http://chatter.local:3001/machine/haas-st10';

    function programEnded(machineId = 'haas-st10', alertName = 'Program ended'): OutgoingMessage {
      return {
        ...alertMessage('started', machineId), alertName, severity: 'warning', link: LINK,
        text: `WARNING - ${machineId}: ${alertName}. Started 9:00 AM. ${LINK}`,
      };
    }

    function queueEvent(channelId: string, alertId: number, now: number, message = programEnded()): number {
      return outbox.queue({ channelId, alertId, message, event: true }, now);
    }

    /** Queues an event message and sends it at `now` */
    function sendEvent(alertId: number, now: number, message = programEnded()): void {
      const id = queueEvent('phones', alertId, now, message);
      if (!outbox.takeDue(now).some(entry => entry.id === id)) throw new Error(`Event ${id} was not due`);
      outbox.markSent(id, 'Sent', now);
    }

    function status(id: number) {
      return outbox.list({}).find(message => message.id === id);
    }

    it('sends the first event of a rule and a machine at once', () => {
      const event = queueEvent('phones', 1, NOW);

      expect(outbox.takeDue(NOW).map(entry => entry.id)).toEqual([event]);
    });

    it(`holds the next event of the same rule and machine until ${EVENT_REPEAT_MS / MINUTE} minutes after the last one went`, () => {
      sendEvent(1, NOW);
      const next = queueEvent('phones', 2, NOW + MINUTE);

      expect(outbox.takeDue(NOW + EVENT_REPEAT_MS - 1)).toEqual([]);
      expect(outbox.takeDue(NOW + EVENT_REPEAT_MS).map(entry => entry.id)).toEqual([next]);
    });

    it('does not hold the other messages of the channel behind an event that waits', () => {
      sendEvent(1, NOW);
      queueEvent('phones', 2, NOW + MINUTE);
      const alarm = queue('phones', 3, alertMessage('started'), NOW + MINUTE);

      expect(outbox.takeDue(NOW + MINUTE).map(entry => entry.id)).toEqual([alarm]);
    });

    it('does not hold an event of another rule or of another machine', () => {
      sendEvent(1, NOW);
      const otherMachine = queueEvent('phones', 2, NOW + MINUTE, programEnded('haas-vf2'));
      expect(outbox.takeDue(NOW + MINUTE).map(entry => entry.id)).toEqual([otherMachine]);
      outbox.markSent(otherMachine, 'Sent', NOW + MINUTE);

      const otherRule = queueEvent('phones', 3, NOW + MINUTE, programEnded('haas-st10', 'Tool change'));
      expect(outbox.takeDue(NOW + MINUTE).map(entry => entry.id)).toEqual([otherRule]);
    });

    it('puts the events that come while one waits into one message, with the count and the time of the first', () => {
      sendEvent(1, NOW);
      const first = queueEvent('phones', 2, NOW + MINUTE);
      const second = queueEvent('phones', 3, NOW + 2 * MINUTE);
      const third = queueEvent('phones', 4, NOW + 3 * MINUTE);

      const detail = `In the next message about this event, because a channel gets at most one message about an event of a machine in ${EVENT_REPEAT_MS / MINUTE} minutes.`;
      expect(status(first)).toMatchObject({ status: 'grouped', detail });
      expect(status(second)).toMatchObject({ status: 'grouped', detail });
      const [entry] = outbox.takeDue(NOW + EVENT_REPEAT_MS);
      expect(entry.id).toBe(third);
      // The default text options give the time in UTC, and the link stays at the end
      expect(entry.message.text).toBe(`WARNING - haas-st10: Program ended. Started 9:00 AM. This happened 3 times since 9:01 AM UTC. ${LINK}`);
      expect(status(third)?.text).toBe(entry.message.text);
    });

    it('gives the time of the first event in the time zone of the shop', () => {
      const chicago = new Outbox(new Database(':memory:'), moreAlerts, () => ({ timeZone: 'America/Chicago', linkBaseUrl: null }));
      const message = { ...programEnded(), link: null, text: 'Program ended.' };
      chicago.queue({ channelId: 'phones', alertId: 1, message, event: true }, NOW);
      chicago.queue({ channelId: 'phones', alertId: 2, message, event: true }, NOW + MINUTE);

      expect(texts(chicago.takeDue(NOW + MINUTE))).toEqual(['Program ended. This happened 2 times since 3:00 AM.']);
    });

    it('counts a sent event message in the limit of the channel', () => {
      for (let alertId = 1; alertId <= SEND_LIMIT; alertId += 1) sendEvent(alertId, NOW, programEnded(`machine-${alertId}`));
      queue('phones', 99, alertMessage('started'), NOW + MINUTE);

      expect(outbox.takeDue(NOW + MINUTE)).toEqual([]);
    });

    it('waits at the limit of the channel, like each other alert', () => {
      sendMessages('phones', SEND_LIMIT, NOW);
      const event = queueEvent('phones', 1, NOW + MINUTE);

      expect(outbox.takeDue(NOW + MINUTE)).toEqual([]);
      expect(outbox.takeDue(NOW + SEND_LIMIT_WINDOW_MS + 1).map(entry => entry.id)).toEqual([event]);
    });

    it('puts an event message into a "more" message, with each event that it has', () => {
      sendEvent(1, NOW);
      sendMessages('phones', SEND_LIMIT - 2, NOW);
      queue('phones', 10, alertMessage('started'), NOW + MINUTE);
      [11, 12, 13].forEach(alertId => queueEvent('phones', alertId, NOW + MINUTE));

      const [more] = outbox.takeDue(NOW + MINUTE);

      expect(more.message).toEqual(moreAlerts(4));
    });

    it('adds the event column to the table of an older Chatter, and keeps its messages', () => {
      const old = new Database(':memory:');
      old.exec(`
        CREATE TABLE notification_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, alert_id INTEGER, kind TEXT NOT NULL, machine_id TEXT,
          payload TEXT NOT NULL, alert_count INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_try_at INTEGER NOT NULL, sending INTEGER NOT NULL DEFAULT 0, last_error TEXT, detail TEXT,
          created_at INTEGER NOT NULL, sent_at INTEGER
        )
      `);
      old.prepare(`
        INSERT INTO notification_messages (channel_id, alert_id, kind, payload, status, next_try_at, created_at)
        VALUES ('phones', 1, 'started', ?, 'waiting', ?, ?)
      `).run(JSON.stringify(alertMessage('started')), NOW, NOW);

      const upgraded = new Outbox(old, moreAlerts);

      expect(texts(upgraded.takeDue(NOW))).toEqual(['started - Haas VF-2: In alarm']);
      upgraded.queue({ channelId: 'slack', alertId: 2, message: alertMessage('started'), event: true }, NOW);
      upgraded.queue({ channelId: 'slack', alertId: 3, message: alertMessage('started'), event: true }, NOW);
      expect(upgraded.list({}).map(message => message.status)).toEqual(['waiting', 'grouped', 'waiting']);
    });

    it('holds a channel whose message failed in an older Chatter, so the next messages do not go past it', () => {
      const failed = queue('phones', 1);
      outbox.takeDue(NOW);
      outbox.markRetry(failed, 'ntfy answered 503.', NOW + 10 * MINUTE);
      db.exec('DELETE FROM notification_channel_holds');
      queue('phones', 2);

      const upgraded = new Outbox(db, moreAlerts);

      expect(upgraded.takeDue(NOW)).toEqual([]);
      expect(upgraded.takeDue(NOW + 10 * MINUTE).map(entry => entry.id)).toEqual([failed]);
    });

    it('counts each event of an event message in the summary after a hold', () => {
      const first = queue('phones', 1);
      outbox.takeDue(NOW);
      outbox.markRetry(first, 'ntfy: the limit is used.', NOW + 60 * MINUTE);
      [2, 3, 4].forEach(alertId => queueEvent('phones', alertId, NOW + alertId * MINUTE));
      [5, 6, 7, 8].forEach(alertId => queue('phones', alertId, alertMessage('started', `machine-${alertId}`), NOW + 10 * MINUTE));

      expect(outbox.takeDue(NOW + 60 * MINUTE)[0].message.text).toBe(
        'Chatter could not send 5 alerts while the channel was blocked: Program ended on Haas VF-2 (3), In alarm on Haas VF-2 (2). '
        + 'Open Chatter to see them.',
      );
    });
  });

  describe('cleanUp', () => {
    it(`deletes the finished messages that are older than 30 days, and keeps the waiting messages`, () => {
      sendMessages('phones', 1, NOW - 31 * DAY);
      queue('slack', 1, alertMessage('started'), NOW - 31 * DAY);
      sendMessages('phones', 1, NOW - 29 * DAY);

      outbox.cleanUp(NOW);

      expect(outbox.list({}).map(message => [message.status, message.createdAt])).toEqual([
        ['sent', new Date(NOW - 29 * DAY).toISOString()],
        ['waiting', new Date(NOW - 31 * DAY).toISOString()],
      ]);
    });

    it(`keeps at most ${MAX_KEPT_MESSAGES} finished messages, the newest`, () => {
      sendMessages('phones', MAX_KEPT_MESSAGES + 2, NOW, SEND_LIMIT_WINDOW_MS);
      const newest = outbox.list({})[0].id;

      outbox.cleanUp(NOW);

      const kept = outbox.list({});
      expect(kept).toHaveLength(MAX_KEPT_MESSAGES);
      expect(kept[0].id).toBe(newest);
    });

    it(`keeps the start of an alert that is still on, also over ${MAX_KEPT_MESSAGES}, so the alert still gets its end message`, () => {
      const finished = (alertId: number, kind: 'started' | 'ended', now: number) => {
        outbox.keepIgnored({ channelId: 'phones', alertId, message: alertMessage(kind) }, 'Ignored', now);
      };
      finished(1, 'started', NOW);
      finished(2, 'started', NOW);
      finished(2, 'ended', NOW);
      outbox.queue({ channelId: 'phones', alertId: 3, message: alertMessage('started'), event: true }, NOW);
      const [event] = outbox.takeDue(NOW);
      outbox.markSent(event.id, 'Sent', NOW);
      sendMessages('slack', MAX_KEPT_MESSAGES, NOW + MINUTE, SEND_LIMIT_WINDOW_MS);

      outbox.cleanUp(NOW + MINUTE);

      expect(outbox.startStatus('phones', 1)).toBe('ignored');
      expect(outbox.startStatus('phones', 2)).toBeNull();
      expect(outbox.startStatus('phones', 3)).toBeNull();
      expect(outbox.list({})).toHaveLength(MAX_KEPT_MESSAGES + 1);
    });
  });

  it('deletes the waiting messages of a removed channel, and keeps its finished messages', () => {
    sendMessages('phones', 1, NOW);
    queue('phones', 2);
    queue('slack', 3);

    outbox.removeChannel('phones');

    expect(outbox.list({}).map(message => [message.channelId, message.status]).sort()).toEqual([['phones', 'sent'], ['slack', 'waiting']]);
  });

  it('deletes the waiting messages of a removed machine', () => {
    queue('phones', 1, alertMessage('started', 'haas-vf2'));
    queue('phones', 2, alertMessage('started', 'haas-st10'));

    outbox.removeMachine('haas-vf2');

    expect(outbox.list({}).map(message => message.machineId)).toEqual(['haas-st10']);
  });

  it('lists the messages of one channel, or since a time, the newest first', () => {
    queue('phones', 1, alertMessage('started'), NOW - 2 * DAY);
    queue('slack', 2, alertMessage('started'), NOW - MINUTE);
    queue('phones', 3, alertMessage('ended'), NOW);

    expect(outbox.list({ channelId: 'phones' }).map(message => message.alertId)).toEqual([3, 1]);
    expect(outbox.list({ since: NOW - DAY }).map(message => message.alertId)).toEqual([3, 2]);
  });
});
