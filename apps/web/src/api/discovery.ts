import type { FoundChatter, FoundMachine } from '../types';
import { api } from './client';

/** The address ranges where the machines probably are, best guess first, such as "192.168.1" */
export async function fetchRangeGuesses(): Promise<string[]> {
  const response = await api.discovery.ranges.$get();
  if (!response.ok) throw new Error('Could not load the address ranges');
  return (await response.json()).ranges;
}

/** What a scan of one range found */
export interface RangeScan {
  /** The machines that are not added yet */
  found: FoundMachine[];
  /** The other Chatter servers. Each one takes the connection of a machine that it polls too. */
  otherChatters: FoundChatter[];
}

/** The machines in `range` that are not added yet, and the other Chatter servers. Takes up to 30 seconds. */
export async function scanRange(range: string): Promise<RangeScan> {
  const response = await api.discovery.scan.$post({ json: { range } });
  const body = await response.json();
  if ('error' in body) throw new Error(body.error);
  return { found: body.found, otherChatters: body.otherChatters };
}
