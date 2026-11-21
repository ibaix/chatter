import { describe, expect, it } from 'vitest';
import type { Alert } from '../alerts/AlertStore.js';
import { alertMessageText, backlogText, moreAlertsText, repeatedEventText, SMS_LENGTH, testMessageText, type TextOptions } from './messageText.js';

const STARTED = Date.UTC(2026, 10, 13, 15, 2);
const ENDED = Date.UTC(2026, 10, 13, 15, 40);
const CHICAGO: TextOptions = { timeZone: 'America/Chicago', linkBaseUrl: null };
const WITH_LINK: TextOptions = { timeZone: 'America/Chicago', linkBaseUrl: 'http://chatter.local:3001' };

function anAlert(values: Partial<Alert> = {}): Alert {
  return {
    name: 'Spindle load above 80%',
    machineId: 'haas-vf2',
    labels: { alertname: 'Spindle load above 80%', machine: 'haas-vf2', severity: 'critical' },
    annotations: { summary: 'Spindle load is 92%' },
    startsAt: STARTED,
    endsAt: ENDED,
    ...values,
  };
}

/** The GSM-7 characters of a text message. A character outside this set makes the limit of one message 70, not 160. */
const PLAIN_TEXT = /^[\x20-\x7e\n]*$/;

describe('alertMessageText', () => {
  it('tells the level, the machine, the alert, the value, and the start time in the time zone of the shop', () => {
    const text = alertMessageText({ kind: 'started', alert: anAlert(), machineName: 'Haas VF-2' }, CHICAGO);

    expect(text).toBe('CRITICAL - Haas VF-2: Spindle load above 80%. Spindle load is 92%. Started 9:02 AM.');
  });

  it('tells the end time of an alert that ended', () => {
    const text = alertMessageText({ kind: 'ended', alert: anAlert(), machineName: 'Haas VF-2' }, CHICAGO);

    expect(text).toBe('OK - Haas VF-2: Spindle load above 80% ended at 9:40 AM.');
  });

  it('tells the start and the end in one message', () => {
    const text = alertMessageText({ kind: 'combined', alert: anAlert(), machineName: 'Haas VF-2' }, CHICAGO);

    expect(text).toBe('CRITICAL - Haas VF-2: Spindle load above 80% started 9:02 AM and ended 9:40 AM.');
  });

  it('does not say the alert two times when the summary is the same as the name', () => {
    const inAlarm = anAlert({ name: 'In alarm', annotations: { summary: 'In alarm' } });

    expect(alertMessageText({ kind: 'started', alert: inAlarm, machineName: 'Haas VF-2' }, CHICAGO))
      .toBe('CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.');
  });

  it('says ALERT when the alert has no known level, and Chatter when it has no machine', () => {
    const other = anAlert({ machineId: undefined, labels: { alertname: 'Disk full' }, name: 'Disk full', annotations: {} });

    expect(alertMessageText({ kind: 'started', alert: other, machineName: null }, CHICAGO))
      .toBe('ALERT - Chatter: Disk full. Started 9:02 AM.');
  });

  it('says ALERT for a level that Chatter does not know', () => {
    const info = anAlert({ labels: { severity: 'info' } });

    expect(alertMessageText({ kind: 'started', alert: info, machineName: 'Haas VF-2' }, CHICAGO)).toMatch(/^ALERT - Haas VF-2: /);
  });

  it('says Chatter when the machine name is blank', () => {
    expect(alertMessageText({ kind: 'ended', alert: anAlert(), machineName: '  ' }, CHICAGO))
      .toBe('OK - Chatter: Spindle load above 80% ended at 9:40 AM.');
  });

  it('shows a long value with one decimal', () => {
    const exact = anAlert({ annotations: { summary: 'Spindle load is 92.33333333333333%, speed 8000.25 RPM' } });

    expect(alertMessageText({ kind: 'started', alert: exact, machineName: 'Haas VF-2' }, CHICAGO))
      .toBe('CRITICAL - Haas VF-2: Spindle load above 80%. Spindle load is 92.3%, speed 8000.25 RPM. Started 9:02 AM.');
  });

  it('uses UTC, and says so, when the time zone is not a known name', () => {
    const text = alertMessageText({ kind: 'ended', alert: anAlert(), machineName: 'Haas VF-2' }, { ...CHICAGO, timeZone: 'Nope/Zone' });

    expect(text).toBe('OK - Haas VF-2: Spindle load above 80% ended at 3:40 PM UTC.');
  });

  it('uses UTC, and says so, when the shop has no time zone', () => {
    const text = alertMessageText({ kind: 'ended', alert: anAlert(), machineName: 'Haas VF-2' }, { ...CHICAGO, timeZone: null });

    expect(text).toBe('OK - Haas VF-2: Spindle load above 80% ended at 3:40 PM UTC.');
  });

  it('sends no link when the Chatter address is blank', () => {
    expect(alertMessageText({ kind: 'ended', alert: anAlert(), machineName: 'Haas VF-2' }, { ...CHICAGO, linkBaseUrl: ' ' }))
      .toBe('OK - Haas VF-2: Spindle load above 80% ended at 9:40 AM.');
  });

  it('adds a link to the machine page when the shop gave the Chatter address', () => {
    const text = alertMessageText({ kind: 'ended', alert: anAlert(), machineName: 'Haas VF-2' }, {
      ...WITH_LINK, linkBaseUrl: 'http://chatter.local:3001/',
    });

    expect(text).toBe('OK - Haas VF-2: Spindle load above 80% ended at 9:40 AM. http://chatter.local:3001/machine/haas-vf2');
  });

  it('puts a machine id with odd letters in the link in a safe form', () => {
    const text = alertMessageText({ kind: 'ended', alert: anAlert({ machineId: 'a b/c' }), machineName: 'A' }, WITH_LINK);

    expect(text).toContain('http://chatter.local:3001/machine/a%20b%2Fc');
  });

  it('uses only the plain letters of a text message', () => {
    for (const kind of ['started', 'ended', 'combined'] as const) {
      expect(alertMessageText({ kind, alert: anAlert(), machineName: 'Haas VF-2' }, WITH_LINK)).toMatch(PLAIN_TEXT);
    }
  });

  it('leaves out the value, and then shortens the alert name, so the message fits in one text message', () => {
    const longName = `Spindle load ${'very '.repeat(30)}high`;
    const text = alertMessageText({
      kind: 'started',
      alert: anAlert({ name: longName, annotations: { summary: 'Spindle load is 92.33333333333333%' } }),
      machineName: 'Haas VF-2',
    }, WITH_LINK);

    expect(text.length).toBeLessThanOrEqual(SMS_LENGTH);
    expect(text).toMatch(/^CRITICAL - Haas VF-2: Spindle load very .*\.\.\.\. Started 9:02 AM\. http:\/\/chatter\.local:3001\/machine\/haas-vf2$/);
    expect(text).not.toContain('92.33');
  });

  it('leaves out only the value when the value is too long, and keeps the name as it is', () => {
    const text = alertMessageText({
      kind: 'started',
      alert: anAlert({ annotations: { summary: `Spindle load is ${'9'.repeat(150)}%` } }),
      machineName: 'Haas VF-2',
    }, CHICAGO);

    expect(text).toBe('CRITICAL - Haas VF-2: Spindle load above 80%. Started 9:02 AM.');
  });

  it('keeps a machine name that is too long for one text message, so the message goes in two parts', () => {
    const longMachine = 'M'.repeat(200);
    const text = alertMessageText({ kind: 'started', alert: anAlert(), machineName: longMachine }, WITH_LINK);

    expect(text).toContain(longMachine);
    expect(text.length).toBeGreaterThan(SMS_LENGTH);
  });
});

describe('moreAlertsText', () => {
  it('tells how many alerts Chatter did not send, with a link to Chatter', () => {
    expect(moreAlertsText(7, CHICAGO)).toBe('And 7 more alerts. Open Chatter to see them.');
    expect(moreAlertsText(1, { ...WITH_LINK, linkBaseUrl: 'http://chatter.local:3001/' }))
      .toBe('And 1 more alert. Open Chatter to see it. http://chatter.local:3001');
  });
});

describe('backlogText', () => {
  it('tells how many alerts Chatter did not send while the channel was blocked, with the most first, and a link', () => {
    const groups = [{ name: 'In alarm on Haas VF-2', count: 2 }, { name: 'Program ended on Haas ST-10', count: 12 }];

    expect(backlogText(groups, WITH_LINK)).toBe(
      'Chatter could not send 14 alerts while the channel was blocked: Program ended on Haas ST-10 (12), In alarm on Haas VF-2 (2). '
      + 'Open Chatter to see them. http://chatter.local:3001',
    );
    expect(backlogText([{ name: 'In alarm on Haas VF-2', count: 1 }], CHICAGO))
      .toBe('Chatter could not send 1 alert while the channel was blocked: In alarm on Haas VF-2 (1). Open Chatter to see it.');
  });

  it('names at most 5 groups, and puts the others together', () => {
    const groups = Array.from({ length: 7 }, (_, index) => ({ name: `Alarm ${index}`, count: 10 - index }));

    expect(backlogText([...groups, { name: null, count: 2 }], CHICAGO)).toBe(
      'Chatter could not send 51 alerts while the channel was blocked: Alarm 0 (10), Alarm 1 (9), Alarm 2 (8), Alarm 3 (7), Alarm 4 (6), '
      + 'other alerts (11). Open Chatter to see them.',
    );
  });
});

describe('repeatedEventText', () => {
  it('tells how many times the event happened since the first one, and keeps the link at the end', () => {
    const link = 'http://chatter.local:3001/machine/haas-vf2';

    expect(repeatedEventText(`WARNING - Haas VF-2: Program ended. Started 9:17 AM. ${link}`, link, 20, STARTED, CHICAGO))
      .toBe(`WARNING - Haas VF-2: Program ended. Started 9:17 AM. This happened 20 times since 9:02 AM. ${link}`);
    expect(repeatedEventText('Program ended.', null, 2, STARTED, { timeZone: null, linkBaseUrl: null }))
      .toBe('Program ended. This happened 2 times since 3:02 PM UTC.');
  });
});

describe('testMessageText', () => {
  it('tells that the channel works, with the link so the user can try it', () => {
    expect(testMessageText(CHICAGO)).toBe('Test from Chatter. Messages to this channel work.');
    expect(testMessageText({ ...WITH_LINK, linkBaseUrl: 'http://chatter.local:3001/' }))
      .toBe('Test from Chatter. Messages to this channel work. http://chatter.local:3001');
  });
});
