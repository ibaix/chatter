import { describe, expect, it } from 'vitest';
import type { MachineAlert } from '../../api/alerts';
import { alertText, alertTone, splitFiring } from './alertList';

function alert(values: Partial<MachineAlert> = {}): MachineAlert {
  return {
    name: 'SpindleTooFast', machineId: 'm1', labels: { alertname: 'SpindleTooFast' }, annotations: {},
    start: '2026-11-09T09:00:00.000Z', end: null, firing: true, ...values,
  };
}

describe('alertText', () => {
  it('gives the summary of the rule', () => {
    expect(alertText(alert({ annotations: { summary: 'Spindle speed is 9000', description: 'Long text' } }))).toBe('Spindle speed is 9000');
  });

  it('gives the description when the rule has no summary', () => {
    expect(alertText(alert({ annotations: { description: 'Long text' } }))).toBe('Long text');
  });

  it('gives no text when the rule has neither', () => {
    expect(alertText(alert())).toBe('');
  });
});

describe('alertTone', () => {
  it.each([['critical', 'bad'], ['warning', 'check'], [undefined, 'check']])('gives severity %s the tone %s', (severity, tone) => {
    const labels: Record<string, string> = severity ? { alertname: 'A', severity } : { alertname: 'A' };

    expect(alertTone(alert({ labels }))).toBe(tone);
  });
});

describe('splitFiring', () => {
  it('splits the firing alerts from the past alerts, and keeps the order in each group', () => {
    const alerts = [
      alert({ name: 'Ended new', firing: false }),
      alert({ name: 'Firing new' }),
      alert({ name: 'Ended old', firing: false }),
      alert({ name: 'Firing old' }),
    ];

    const { firing, past } = splitFiring(alerts);

    expect(firing.map(found => found.name)).toEqual(['Firing new', 'Firing old']);
    expect(past.map(found => found.name)).toEqual(['Ended new', 'Ended old']);
  });
});
