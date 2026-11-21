import type { AddMachineRequest, FoundChatter, FoundMachine } from '@local-chatter/shared';
import { addressesIn, type AddressRange } from './addressRange.js';
import { ANSWER_TIMEOUT_MS, askBrother, askChatter, askHaas, askMTConnect, CHATTER_PORT, MACHINE_PORTS, maybeFanuc, maybeSiemens } from './askMachines.js';
import { isPortOpen, mapWithLimit } from './tcp.js';

/** The ports to try first. Only an open port gets a real question. */
const KNOCK_PORTS = [
  MACHINE_PORTS.brother, MACHINE_PORTS.haasQuery, ...MACHINE_PORTS.mtconnect, MACHINE_PORTS.fanuc, MACHINE_PORTS.siemens, CHATTER_PORT,
];
/**
 * No answer in this time means nothing is there. On a wired network a machine answers in a few milliseconds.
 * Over WiFi, and through Docker Desktop on a Mac, the first answer can take more than a second.
 */
export const KNOCK_TIMEOUT_MS = 2000;
/** Addresses checked at the same time. Each one tries all ports at once, so this keeps the open connections low. */
const ADDRESSES_AT_ONCE = 48;

/** The longest time a scan of `addressCount` addresses can take: each address waits for the knock, then for an answer */
export function longestScanMs(addressCount: number): number {
  const rounds = Math.ceil(addressCount / ADDRESSES_AT_ONCE);
  return rounds * (KNOCK_TIMEOUT_MS + ANSWER_TIMEOUT_MS);
}

/** The ports on `host` that accept a connection */
async function openPortsOf(host: string): Promise<Set<number>> {
  const isOpen = await Promise.all(KNOCK_PORTS.map(port => isPortOpen(host, port, KNOCK_TIMEOUT_MS)));
  return new Set(KNOCK_PORTS.filter((_, index) => isOpen[index]));
}

/** What the scan found at one address: the machines, and another Chatter server */
export interface FoundAtAddress {
  machines: FoundMachine[];
  chatter: FoundChatter | null;
}

/** What a scan found: the machines that are not added yet, and the other Chatter servers */
export interface ScanResult {
  machines: FoundMachine[];
  chatters: FoundChatter[];
}

/** Ask each open port what machine is there, and if another Chatter server is there */
async function foundAt(host: string): Promise<FoundAtAddress> {
  const openPorts = await openPortsOf(host);
  if (openPorts.size === 0) return { machines: [], chatter: null };
  const [machines, chatter] = await Promise.all([
    machinesAt(host, openPorts),
    openPorts.has(CHATTER_PORT) ? askChatter(host) : null,
  ]);
  return { machines, chatter };
}

async function machinesAt(host: string, openPorts: Set<number>): Promise<FoundMachine[]> {
  const answers = await Promise.all([
    openPorts.has(MACHINE_PORTS.brother) ? askBrother(host) : null,
    openPorts.has(MACHINE_PORTS.haasQuery) ? askHaas(host) : null,
    ...MACHINE_PORTS.mtconnect.map(port => (openPorts.has(port) ? askMTConnect(host, port) : null)),
    openPorts.has(MACHINE_PORTS.fanuc) ? maybeFanuc(host) : null,
    openPorts.has(MACHINE_PORTS.siemens) ? maybeSiemens(host) : null,
  ]);
  return answers.filter((answer): answer is FoundMachine => answer !== null);
}

export class ScanAlreadyRunningError extends Error {
  constructor() {
    super('A scan is already running. Wait for it to finish.');
  }
}

/**
 * Finds machines in one address range. Only one scan runs at a time,
 * so the server never sends a large number of connections into the shop network.
 */
export class NetworkScanner {
  private isScanning = false;

  /** `findAt` finds the machines and a Chatter server at one address. Tests give their own. */
  constructor(private readonly findAt: (host: string) => Promise<FoundAtAddress> = foundAt) {}

  /**
   * The machines in `range` that are not added yet, and the other Chatter servers.
   * `isThisChatter` leaves out this server itself.
   */
  async scan(
    range: AddressRange,
    isAdded: (machine: AddMachineRequest) => boolean,
    isThisChatter: (chatter: FoundChatter) => boolean = () => false,
  ): Promise<ScanResult> {
    if (this.isScanning) throw new ScanAlreadyRunningError();
    this.isScanning = true;
    try {
      const found = await mapWithLimit(addressesIn(range), ADDRESSES_AT_ONCE, this.findAt);
      return {
        machines: found.flatMap(item => item.machines).filter(result => !isAdded(result.machine)),
        chatters: found.flatMap(item => (item.chatter && !isThisChatter(item.chatter) ? [item.chatter] : [])),
      };
    } finally {
      this.isScanning = false;
    }
  }
}
