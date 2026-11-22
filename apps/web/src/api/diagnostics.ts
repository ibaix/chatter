import type { ConnectionTestReport, MachineHealth } from '@local-chatter/shared';
import type { InferResponseType } from 'hono/client';
import { api } from './client';
import { errorOf, jsonOrThrow } from './replies';

/** Settings > Diagnostics, and the connection of one machine */

export type SystemFacts = InferResponseType<typeof api.system.facts.$get, 200>;

export async function fetchSystemFacts(): Promise<SystemFacts> {
  return jsonOrThrow(await api.system.facts.$get(), 'Could not load the facts of Chatter');
}

/** Chatter ends its process, and Docker starts it again */
export async function restartChatter(): Promise<void> {
  await jsonOrThrow(await api.system['restart-chatter'].$post(), 'Could not restart Chatter');
}

/** The update helper restarts the Pi */
export async function restartPi(): Promise<void> {
  await jsonOrThrow(await api.system['restart-pi'].$post(), 'Could not restart the Pi');
}

/**
 * The random name of the server process, which changes at each start, or null while Chatter does not answer.
 * A restart wait compares these names, not times: the clock of the Pi and the clock of the browser can be different.
 */
export async function fetchInstance(): Promise<string | null> {
  try {
    const response = await api.health.$get();
    if (!response.ok) return null;
    const { instance } = await response.json();
    return instance;
  } catch {
    return null;
  }
}

export interface DebugState {
  debugUntil: string | null;
}

export async function fetchDebugState(): Promise<DebugState> {
  return jsonOrThrow(await api.logs.debug.$get(), 'Could not load the log level');
}

/** Turn on the debug level for 15 minutes, or off */
export async function setDebug(on: boolean): Promise<DebugState> {
  return jsonOrThrow(await api.logs.debug.$put({ json: { on } }), 'Could not change the log level');
}

export interface LogFilter {
  level?: 'debug' | 'info' | 'warn' | 'error';
  machine?: string;
}

/** The query of a log filter, with no empty value */
function filterQuery({ level, machine }: LogFilter): Record<string, string> {
  return { ...(level && { level }), ...(machine && { machine }) };
}

/** The address of the log download, as a text file */
export function logDownloadUrl(filter: LogFilter): string {
  const url = api.logs.$url({ query: filterQuery(filter) });
  return `${url.pathname}${url.search}`;
}

/** The address of the support bundle download (.tar.gz) */
export function supportBundleUrl(): string {
  return api['support-bundle'].$url().pathname;
}

/** The address of the live log (server-sent events) */
export function logStreamUrl(filter: LogFilter): string {
  const url = api.logs.stream.$url({ query: filterQuery(filter) });
  return `${url.pathname}${url.search}`;
}

/** The text of the helper log of the Pi, or null when the helper writes none (an older card image) */
export async function fetchHelperLog(): Promise<string | null> {
  const response = await api.updates['helper-log'].$get();
  if (response.status === 404) return null;
  const error = await errorOf(response, 'Could not load the helper log');
  if (error) throw new Error(error);
  return response.text();
}

export async function fetchMachineHealth(machineId: string): Promise<MachineHealth> {
  return jsonOrThrow(await api.machine[':id'].health.$get({ param: { id: machineId } }), 'Could not load the connection of the machine');
}

/** Test the connection to the saved host and ports of a machine. Takes up to about 10 seconds. */
export async function testMachineConnection(machineId: string): Promise<ConnectionTestReport> {
  return jsonOrThrow(await api.machine[':id'].test.$post({ param: { id: machineId } }), 'Could not test the connection');
}

/** Disconnect the machine and poll it now. Gives the text to show. */
export async function reconnectMachine(machineId: string): Promise<string> {
  const { message } = await jsonOrThrow<{ message: string }>(
    await api.machine[':id'].reconnect.$post({ param: { id: machineId } }), 'Could not reconnect the machine',
  );
  return message;
}
