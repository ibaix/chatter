import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import { ConnectionLog, KEPT_CONNECTION_EVENTS } from './ConnectionLog.js';
import { captureLog, type CapturedLog } from './testSupport.js';

const START = new Date('2026-11-12T10:00:00.000Z').getTime();
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

function polled(connected: boolean, errors: string[] = []): BaseMachineConnector {
  return {
    getStatus: () => ({ id: 'm1', name: 'Speedio', type: 'brother', host: '10.0.0.5', connected, errors }),
  } as unknown as BaseMachineConnector;
}

describe('ConnectionLog health', () => {
  let log: CapturedLog;
  let now: number;
  let connecting: boolean;
  let connections: ConnectionLog;

  beforeEach(() => {
    log = captureLog();
    now = START;
    connecting = false;
    connections = new ConnectionLog(undefined, () => new Date(now), () => connecting);
  });

  afterEach(() => log.restore());

  it('knows nothing of a machine before its first poll', () => {
    expect(connections.health('m1')).toEqual({ offlineSince: null, lastError: null, events: [] });
  });

  it('keeps each connection change with its time and reason, newest first', () => {
    connections.record(polled(true));
    now = START + 60_000;
    connections.record(polled(false, ['Poll failed: connect ECONNREFUSED 10.0.0.5:10000']));
    now = START + 120_000;
    connections.record(polled(true));

    expect(connections.health('m1')).toEqual({
      offlineSince: null,
      lastError: { text: 'Poll failed: connect ECONNREFUSED 10.0.0.5:10000', time: at(60) },
      events: [
        { time: at(120), tone: 'good', text: 'Machine is online again' },
        { time: at(60), tone: 'bad', text: 'Machine went offline: Poll failed: connect ECONNREFUSED 10.0.0.5:10000' },
        { time: at(0), tone: 'good', text: 'Machine connected' },
      ],
    });
  });

  it('tells since when the machine is offline, and keeps the first time of the same error', () => {
    connections.record(polled(true));
    now = START + 10_000;
    connections.record(polled(false, ['Poll failed: timeout']));
    now = START + 20_000;
    connections.record(polled(false, ['Poll failed: timeout']));
    expect(connections.health('m1')).toMatchObject({ offlineSince: at(10), lastError: { text: 'Poll failed: timeout', time: at(10) } });
  });

  it('keeps the error of a machine that is still connecting, but no change', () => {
    connecting = true;
    connections.record(polled(false, ['Unable to connect: EHOSTUNREACH']));
    expect(connections.health('m1')).toEqual({
      offlineSince: null, lastError: { text: 'Unable to connect: EHOSTUNREACH', time: at(0) }, events: [],
    });
  });

  it(`keeps only the last ${KEPT_CONNECTION_EVENTS} changes`, () => {
    for (let index = 0; index < 8; index++) {
      now = START + index * 1000;
      connections.record(polled(index % 2 === 0));
    }
    // Connected, then 7 changes, and 4 problem lines in between: more than 10 events
    for (let index = 0; index < 5; index++) {
      now = START + (10 + index) * 1000;
      connections.record(polled(true, [`problem ${index}`]));
    }
    const { events } = connections.health('m1');
    expect(events).toHaveLength(KEPT_CONNECTION_EVENTS);
    expect(events[0]).toEqual({ time: at(14), tone: 'bad', text: 'Machine reports a problem: problem 4' });
  });

  it('forgets a removed machine', () => {
    connections.record(polled(false, ['x']));
    connections.removeMachine('m1');
    expect(connections.health('m1')).toEqual({ offlineSince: null, lastError: null, events: [] });
  });
});
