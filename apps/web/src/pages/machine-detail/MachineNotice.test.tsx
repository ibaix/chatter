import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { machinesWhileChatterIsLost, machineStateOf } from '../../machines/machineStatus';
import { testMachine } from '../../test/testMachine';
import { MachineNotice } from './MachineNotice';

describe('MachineNotice', () => {
  it('tells that the page lost Chatter, and does not show the machine as running', () => {
    const now = Date.now();
    const [machine] = machinesWhileChatterIsLost([
      testMachine({ connected: true, lastPollTime: new Date(now - 17 * 60_000).toISOString() }, { execution: 'ACTIVE' }),
    ]);

    render(<MachineNotice machine={machine} state={machineStateOf(machine)} now={now} chatterIsLost />);

    expect(screen.getByText('Lost the connection to Chatter')).toBeInTheDocument();
    expect(screen.getByText(/The last values came 17 min ago\./)).toBeInTheDocument();
    expect(machineStateOf(machine)).toBe('connecting');
  });

  it('shows why an offline machine cannot be reached, with a link to what to do', () => {
    const machine = testMachine({ connected: false, errors: ['Connection timeout'] });

    render(<MachineNotice machine={machine} state="offline" now={Date.now()} />);

    expect(screen.getByText('Connection timeout')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'What to do when a machine is offline' }))
      .toHaveAttribute('href', expect.stringMatching(/\/guide\/get-started#if-a-machine-shows-offline$/));
  });

  it('shows no notice for a machine that runs while the page is live', () => {
    const machine = testMachine({ connected: true }, { execution: 'ACTIVE' });

    const { container } = render(<MachineNotice machine={machine} state={machineStateOf(machine)} now={Date.now()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
