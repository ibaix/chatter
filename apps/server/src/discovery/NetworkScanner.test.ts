import type { FoundMachine } from '@local-chatter/shared';
import { describe, expect, it } from 'vitest';
import { KNOCK_TIMEOUT_MS, longestScanMs, NetworkScanner, ScanAlreadyRunningError, type FoundAtAddress } from './NetworkScanner.js';

const haasAt = (host: string): FoundMachine => ({
  machine: { type: 'haas', name: 'Haas', host, dataPort: 9998, queryPort: 5051 },
  isConfirmed: true,
  detail: '',
});

describe('NetworkScanner', () => {
  it('tries .1 to .254 and leaves out the machines that are added already', async () => {
    const tried: string[] = [];
    const scanner = new NetworkScanner(async host => {
      tried.push(host);
      return { machines: host.endsWith('.10') || host.endsWith('.20') ? [haasAt(host)] : [], chatter: null };
    });
    const found = await scanner.scan('10.0.0', machine => machine.host === '10.0.0.10');
    expect(tried).toHaveLength(254);
    expect(found.machines.map(result => result.machine.host)).toEqual(['10.0.0.20']);
  });

  it('lists the other Chatter servers, and leaves out this one', async () => {
    const scanner = new NetworkScanner(async host => ({
      machines: [],
      chatter: host.endsWith('.5') || host.endsWith('.6') ? { host, version: '1.2.0' } : null,
    }));
    const { chatters } = await scanner.scan('10.0.0', () => false, chatter => chatter.host === '10.0.0.6');
    expect(chatters).toEqual([{ host: '10.0.0.5', version: '1.2.0' }]);
  });

  it('refuses a second scan while one runs', async () => {
    let release = () => {};
    const gate = new Promise<FoundAtAddress>(resolve => { release = () => resolve({ machines: [], chatter: null }); });
    const scanner = new NetworkScanner(() => gate);
    const first = scanner.scan('10.0.0', () => false);
    await expect(scanner.scan('10.0.0', () => false)).rejects.toBeInstanceOf(ScanAlreadyRunningError);
    release();
    await first;
  });

  it('allows a new scan after a scan fails', async () => {
    let shouldFail = true;
    const scanner = new NetworkScanner(async () => {
      if (shouldFail) throw new Error('network down');
      return { machines: [], chatter: null };
    });
    await expect(scanner.scan('10.0.0', () => false)).rejects.toThrow('network down');
    shouldFail = false;
    await expect(scanner.scan('10.0.0', () => false)).resolves.toEqual({ machines: [], chatters: [] });
  });

  it('waits 2 seconds for each port, because WiFi and Docker Desktop on a Mac answer slowly', () => {
    expect(KNOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
  });

  it('ends a scan of .1 to .254 in 30 seconds, also when each address waits the longest time', () => {
    expect(longestScanMs(254)).toBeLessThanOrEqual(30_000);
  });
});
