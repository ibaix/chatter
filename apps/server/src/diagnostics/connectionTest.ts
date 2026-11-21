import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConnectionTestReport, ConnectionTestStep } from '@local-chatter/shared';
import type { FoundMachine } from '@local-chatter/shared';
import { askBrother, askHaas, askMTConnect } from '../discovery/askMachines.js';
import { tryConnect, type PortState } from '../discovery/tcp.js';
import type { BaseMachineStatus } from '../types/index.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('diagnostics');

/** The time limit of each step: the DNS lookup, each port, and the question to the machine */
const TEST_STEP_TIMEOUT_MS = 3000;
/** One test of a machine at a time, and at most one test in this time, so the test cannot flood the machine */
const TEST_INTERVAL_MS = 10_000;
/** After the disconnect, the control gets a moment to free its connection */
const SETTLE_MS = 300;

/** The machine fields with a port, and the name of each port on the page */
const PORT_FIELDS = [
  ['dataPort', 'data'],
  ['queryPort', 'Q commands'],
  ['mtConnectPort', 'MTConnect agent'],
  ['focasPort', 'FOCAS'],
  ['opcuaPort', 'OPC UA'],
  ['ftpPort', 'FTP, for files'],
] as const;

/** The machine as the test sees it: the saved settings only, never an address from the request */
type TestedMachine = BaseMachineStatus & Partial<Record<(typeof PORT_FIELDS)[number][0], number>>;

/** What the test needs from the poller */
export interface TestedMachines {
  getMachine(id: string): BaseMachineStatus | null;
  /** Stop the polls and disconnect, because a Brother control serves only one connection */
  pauseMachine(id: string): boolean;
  resumeMachine(id: string): void;
}

/** The test cannot run now. The status is the HTTP status of the reply. */
export class TestRefusedError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 429) {
    super(message);
  }
}

export interface ConnectionTesterOptions {
  stepTimeoutMs?: number;
  intervalMs?: number;
  settleMs?: number;
  now?: () => number;
}

/**
 * The connection test on the machine settings page: a DNS lookup of the saved host, a TCP connection to each
 * saved port, and one short question in the protocol of the machine. It uses no ping (ICMP): the container may not
 * send it, and a control can block it. Each text is fixed, so no text from the machine is shown.
 */
export class ConnectionTester {
  private readonly running = new Set<string>();
  private readonly lastStarts = new Map<string, number>();
  private readonly stepTimeoutMs: number;
  private readonly intervalMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;

  constructor(private readonly machines: TestedMachines, options: ConnectionTesterOptions = {}) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? TEST_STEP_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? TEST_INTERVAL_MS;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.now = options.now ?? Date.now;
  }

  async test(machineId: string, username: string): Promise<ConnectionTestReport> {
    const machine = this.machines.getMachine(machineId) as TestedMachine | null;
    if (!machine) throw new TestRefusedError('Machine not found', 404);
    this.takePlace(machineId);
    log.info('Connection test started', { machine: machineId, user: username });
    const wasPolled = this.machines.pauseMachine(machineId);
    try {
      await new Promise(resolve => setTimeout(resolve, this.settleMs));
      const steps = await this.runSteps(machine);
      log.info('Connection test ended', { machine: machineId, results: steps.map(step => step.result).join(',') });
      return { host: machine.host, testedAt: new Date(this.now()).toISOString(), steps };
    } finally {
      this.running.delete(machineId);
      if (wasPolled) this.machines.resumeMachine(machineId);
    }
  }

  private takePlace(machineId: string): void {
    if (this.running.has(machineId)) throw new TestRefusedError('A test of this machine runs now. Wait until it ends.', 409);
    const sinceLastMs = this.now() - (this.lastStarts.get(machineId) ?? -Infinity);
    if (sinceLastMs < this.intervalMs) {
      throw new TestRefusedError(`Wait ${Math.ceil((this.intervalMs - sinceLastMs) / 1000)} s before the next test of this machine.`, 429);
    }
    this.running.add(machineId);
    this.lastStarts.set(machineId, this.now());
  }

  private async runSteps(machine: TestedMachine): Promise<ConnectionTestStep[]> {
    const dns = await this.lookUp(machine.host);
    if (dns.result === 'failed') return [dns];
    const ports = portsOf(machine);
    const states = await Promise.all(ports.map(({ port }) => tryConnect(machine.host, port, this.stepTimeoutMs)));
    const portSteps = ports.map(({ port, label }, index) => portStep(port, label, states[index]));
    const isOpen = (port: number | undefined) => ports.some((item, index) => item.port === port && states[index] === 'open');
    return [dns, ...portSteps, await this.askMachine(machine, isOpen)];
  }

  private async lookUp(host: string): Promise<ConnectionTestStep> {
    const name = 'Address';
    if (isIP(host)) return { name, result: 'ok', text: `${host} is an IP address, so no DNS lookup is necessary.` };
    try {
      const { address } = await withTimeout(lookup(host), this.stepTimeoutMs);
      return { name, result: 'ok', text: `The DNS lookup of ${host} gives ${address}.` };
    } catch {
      return {
        name, result: 'failed', text: `Chatter cannot find the address of ${host} (DNS).`,
        hint: 'Use the IP address of the machine, or check the host name.',
      };
    }
  }

  /** One read-only question in the protocol of the machine, on its saved port */
  private async askMachine(machine: TestedMachine, isOpen: (port: number | undefined) => boolean): Promise<ConnectionTestStep> {
    const question = this.questionFor(machine);
    if (!question) {
      return {
        name: 'Answer', result: 'skipped',
        text: 'Chatter has no short test for this protocol. The port test above shows if Chatter can reach the machine.',
      };
    }
    if (!isOpen(question.port)) {
      return { name: 'Answer', result: 'skipped', text: `No question was sent, because port ${question.port} is not open.` };
    }
    if (await question.ask()) return { name: 'Answer', result: 'ok', text: question.answerText };
    return {
      name: 'Answer', result: 'failed',
      text: `Connected to port ${question.port}, but no correct reply came in ${this.stepTimeoutMs / 1000} s.`,
      hint: question.noReplyHint,
    };
  }

  private questionFor(machine: TestedMachine): MachineQuestion | null {
    const { host } = machine;
    const timeout = this.stepTimeoutMs;
    switch (machine.type) {
      case 'brother':
        return machine.dataPort === undefined ? null : {
          port: machine.dataPort,
          ask: () => askBrother(host, machine.dataPort!, timeout),
          answerText: 'The machine answered as a Brother CNC.',
          noReplyHint: 'Another program may be connected. A Brother control serves only one connection: '
            + 'stop the other program, for example another Chatter server, or a Chatter on a laptop.',
        };
      case 'haas':
        return machine.queryPort === undefined ? null : {
          port: machine.queryPort,
          ask: () => askHaas(host, machine.queryPort!, timeout),
          answerText: 'The machine answered as a Haas CNC (Q100).',
          noReplyHint: 'Another program may be connected, or the port is not the Q command port. '
            + 'Check Setting 143 (Machine Data Collect) on the control.',
        };
      case 'mtconnect':
        return machine.mtConnectPort === undefined ? null : {
          port: machine.mtConnectPort,
          ask: () => askMTConnect(host, machine.mtConnectPort!, timeout),
          answerText: 'The MTConnect agent answered.',
          noReplyHint: 'The port is open, but it is not an MTConnect agent, or the agent is busy. Check the port.',
        };
      default:
        return null;
    }
  }
}

interface MachineQuestion {
  port: number;
  ask: () => Promise<FoundMachine | null>;
  answerText: string;
  noReplyHint: string;
}

/** Each saved port of the machine once, with its name */
function portsOf(machine: TestedMachine): { port: number; label: string }[] {
  const ports: { port: number; label: string }[] = [];
  for (const [field, label] of PORT_FIELDS) {
    const port = machine[field];
    if (typeof port === 'number' && !ports.some(item => item.port === port)) ports.push({ port, label });
  }
  return ports;
}

function portStep(port: number, label: string, state: PortState): ConnectionTestStep {
  const name = `Port ${port} (${label})`;
  // FTP is only for files, so a closed FTP port does not stop the machine data
  const isOptional = label.startsWith('FTP');
  switch (state) {
    case 'open':
      return { name, result: 'ok', text: 'The port is open.' };
    case 'refused':
      return {
        name, result: isOptional ? 'warning' : 'failed', text: 'The machine refused the connection: nothing listens on this port.',
        hint: 'The machine is on, but the port is wrong, or its service is off on the control.',
      };
    case 'timeout':
      return {
        name, result: isOptional ? 'warning' : 'failed', text: `No answer in ${TEST_STEP_TIMEOUT_MS / 1000} s.`,
        hint: 'The machine is off, a firewall blocks the port, or the address is wrong.',
      };
    case 'unreachable':
      return {
        name, result: 'failed', text: 'Chatter cannot reach this address.',
        hint: 'Check the address, the network cable, and that the machine is on the same network.',
      };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
