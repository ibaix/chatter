import { describe, expect, it } from 'vitest';
import { BrotherConnector } from './brother/BrotherConnector.js';

/** Any connector, because reportPollTimeout comes from BaseMachineConnector */
function connector(): BrotherConnector {
  return new BrotherConnector({ id: 'm1', name: 'M', host: '127.0.0.1' });
}

describe('reportPollTimeout', () => {
  it('tells the user the time limit in seconds, and that Chatter connects again', () => {
    const machine = connector();

    machine.reportPollTimeout(10000);

    expect(machine.getStatus().errors[0]).toBe(
      'The machine did not answer all requests in 10 seconds. Chatter disconnected. It will connect again.',
    );
  });

  it('never tells the user 0 seconds for a time limit under one second', () => {
    const machine = connector();

    machine.reportPollTimeout(300);

    expect(machine.getStatus().errors[0]).toBe(
      'The machine did not answer all requests in 1 second. Chatter disconnected. It will connect again.',
    );
  });
});
