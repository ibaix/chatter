import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMachineStatus } from '../types/index.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import type { PortState } from '../discovery/tcp.js';
import { ConnectionTester, TestRefusedError, type TestedMachines } from './connectionTest.js';

/** A port state that each port test gives, in place of a real connect. Null: a real connect. */
const portStateForTest = vi.hoisted(() => ({ state: null as PortState | null }));
vi.mock('../discovery/tcp.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../discovery/tcp.js')>();
  return {
    ...actual,
    tryConnect: (...args: Parameters<typeof actual.tryConnect>) =>
      (portStateForTest.state ? Promise.resolve(portStateForTest.state) : actual.tryConnect(...args)),
  };
});

/** A fake control on 127.0.0.1. `reply` gives the answer to each request, or null for no answer. */
async function fakeControl(reply: (request: string) => string | null): Promise<{ port: number; close: () => Promise<void>; connections: () => number }> {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('data', data => {
      const answer = reply(data.toString('ascii'));
      if (answer !== null) socket.write(answer);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    connections: () => connections,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** A port where nothing listens */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function machinesWith(machine: Partial<BaseMachineStatus> & Record<string, unknown>) {
  const status = { id: 'm1', name: 'Speedio', host: '127.0.0.1', type: 'brother', ...machine } as BaseMachineStatus;
  const calls: string[] = [];
  const machines: TestedMachines = {
    getMachine: id => (id === 'm1' ? status : null),
    pauseMachine: () => {
      calls.push('pause');
      return true;
    },
    resumeMachine: () => void calls.push('resume'),
  };
  return { machines, calls };
}

describe('ConnectionTester', () => {
  let log: CapturedLog;
  const closers: (() => Promise<void>)[] = [];

  beforeEach(() => {
    log = captureLog();
  });

  afterEach(async () => {
    portStateForTest.state = null;
    log.restore();
    await Promise.all(closers.splice(0).map(close => close()));
  });

  const tester = (machines: TestedMachines, now = Date.now) => new ConnectionTester(machines, { stepTimeoutMs: 300, settleMs: 0, now });

  it('a Brother that answers: each step is ok, and the polls stop during the test and start again', async () => {
    const control = await fakeControl(() => '%RLOD    MEM     00\r\nO1234\r\n%');
    closers.push(control.close);
    const ftp = await fakeControl(() => null);
    closers.push(ftp.close);
    const { machines, calls } = machinesWith({ dataPort: control.port, ftpPort: ftp.port });

    const report = await tester(machines).test('m1', 'admin');

    expect(report.host).toBe('127.0.0.1');
    expect(report.steps).toEqual([
      { name: 'Address', result: 'ok', text: '127.0.0.1 is an IP address, so no DNS lookup is necessary.' },
      { name: `Port ${control.port} (data)`, result: 'ok', text: 'The port is open.' },
      { name: `Port ${ftp.port} (FTP, for files)`, result: 'ok', text: 'The port is open.' },
      { name: 'Answer', result: 'ok', text: 'The machine answered as a Brother CNC.' },
    ]);
    expect(calls).toEqual(['pause', 'resume']);
    expect(log.text()).toContain('Connection test started machine=m1 user=admin');
  });

  it('a Brother that accepts but does not answer: "another program may be connected"', async () => {
    const control = await fakeControl(() => null);
    closers.push(control.close);
    const { machines } = machinesWith({ dataPort: control.port });

    const { steps } = await tester(machines).test('m1', 'admin');

    expect(steps.at(-1)).toEqual({
      name: 'Answer', result: 'failed', text: `Connected to port ${control.port}, but no correct reply came in 0.3 s.`,
      hint: expect.stringContaining('Another program may be connected.'),
    });
  });

  it('a closed port: refused, and no question is sent', async () => {
    const port = await closedPort();
    const { machines } = machinesWith({ dataPort: port });

    const { steps } = await tester(machines).test('m1', 'admin');

    expect(steps[1]).toMatchObject({ result: 'failed', text: 'The machine refused the connection: nothing listens on this port.' });
    expect(steps.at(-1)).toEqual({ name: 'Answer', result: 'skipped', text: `No question was sent, because port ${port} is not open.` });
  });

  it('a closed FTP port is only a warning', async () => {
    const control = await fakeControl(() => '%RLOD    MEM     00\r\n%');
    closers.push(control.close);
    const { machines } = machinesWith({ dataPort: control.port, ftpPort: await closedPort() });
    const { steps } = await tester(machines).test('m1', 'admin');
    expect(steps[2]).toMatchObject({ result: 'warning' });
  });

  it('a host name that DNS cannot find stops the test after the first step', async () => {
    const { machines, calls } = machinesWith({ host: 'no-such-machine.invalid', dataPort: 10000 });
    const { steps } = await tester(machines).test('m1', 'admin');
    expect(steps).toEqual([{
      name: 'Address', result: 'failed', text: 'Chatter cannot find the address of no-such-machine.invalid (DNS).',
      hint: 'Use the IP address of the machine, or check the host name.',
    }]);
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('a FANUC machine gets the port test only', async () => {
    const control = await fakeControl(() => null);
    closers.push(control.close);
    const { machines } = machinesWith({ type: 'fanuc', focasPort: control.port });
    const { steps } = await tester(machines).test('m1', 'admin');
    expect(steps.map(step => step.result)).toEqual(['ok', 'ok', 'skipped']);
    await vi.waitFor(() => expect(control.connections()).toBe(1));
  });

  it('a port with no answer tells the time limit of the test', async () => {
    portStateForTest.state = 'timeout';
    const { machines } = machinesWith({ type: 'fanuc', focasPort: 8193 });
    const { steps } = await tester(machines).test('m1', 'admin');
    expect(steps[1]).toMatchObject({ name: 'Port 8193 (FOCAS)', result: 'failed', text: 'No answer in 0.3 s.' });
  });

  it('a Haas: asks Q100 on the Q command port', async () => {
    const control = await fakeControl(request => (request.includes('Q100') ? '>SERIAL NUMBER, 1234567\r\n' : null));
    closers.push(control.close);
    const { machines } = machinesWith({ type: 'haas', queryPort: control.port });
    const { steps } = await tester(machines).test('m1', 'admin');
    expect(steps.at(-1)).toEqual({ name: 'Answer', result: 'ok', text: 'The machine answered as a Haas CNC (Q100).' });
  });

  it('allows one test of a machine at a time, and at most one in 10 seconds', async () => {
    const control = await fakeControl(() => null);
    closers.push(control.close);
    const { machines } = machinesWith({ dataPort: control.port });
    let now = 1_000_000;
    const test = tester(machines, () => now);

    const first = test.test('m1', 'admin');
    await expect(test.test('m1', 'admin')).rejects.toEqual(new TestRefusedError('A test of this machine runs now. Wait until it ends.', 409));
    await first;
    now += 4000;
    await expect(test.test('m1', 'admin')).rejects.toMatchObject({ status: 429, message: 'Wait 6 s before the next test of this machine.' });
    now += 6000;
    await expect(test.test('m1', 'admin')).resolves.toBeDefined();
  });

  it('refuses an unknown machine', async () => {
    const { machines } = machinesWith({});
    await expect(tester(machines).test('nope', 'admin')).rejects.toMatchObject({ status: 404 });
  });

  it('starts the polls again also when a step throws', async () => {
    const { machines, calls } = machinesWith({ dataPort: 1 });
    const test = tester(machines);
    vi.spyOn(test as unknown as { runSteps: () => Promise<never> }, 'runSteps').mockRejectedValue(new Error('boom'));
    await expect(test.test('m1', 'admin')).rejects.toThrow('boom');
    expect(calls).toEqual(['pause', 'resume']);
  });
});
