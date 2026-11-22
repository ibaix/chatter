import type { FoundChatter, FoundMachine } from '@local-chatter/shared';
import { parseStringPromise } from 'xml2js';
import { brotherCommand } from '../machines/brother/brotherProtocol.js';
import { buildCommandString } from '../machines/haas/HaasConnector.js';
import { DEFAULT_DATA_PORTS, DEFAULT_HAAS_QUERY_PORT } from '../polling/machinePorts.js';
import { askOverTcp } from './tcp.js';

/**
 * Each function asks one machine type a real question, so an open port alone is not enough.
 * A printer or a PC with the same open port does not give the right answer.
 */

/** The ports the scan tries. They are the defaults of each machine type. */
export const MACHINE_PORTS = {
  brother: DEFAULT_DATA_PORTS.brother,
  haasData: DEFAULT_DATA_PORTS.haas,
  haasQuery: DEFAULT_HAAS_QUERY_PORT,
  /** An agent PC can serve one machine on each port */
  mtconnect: [5000, 5001, 5002],
  fanuc: DEFAULT_DATA_PORTS.fanuc,
  siemens: DEFAULT_DATA_PORTS.siemens,
} as const;

/** The port of Chatter itself. Another Chatter server on the network takes the connection of each machine that it polls. */
export const CHATTER_PORT = 3001;

/** The time limit for a machine to answer the question on an open port */
export const ANSWER_TIMEOUT_MS = 2000;

/** A Brother program in memory starts and ends with a % sign */
const BROTHER_PROGRAM_PATTERN = /%[^%]*%/;
/** A Q100 reply such as ">SERIAL NUMBER, 1234567" */
const HAAS_SERIAL_PATTERN = /SERIAL NUMBER,\s*(\S+)/;
/** Every MTConnect probe reply has this root tag */
const MTCONNECT_PROBE_TAG = 'MTConnectDevices';
/** A probe reply of an agent with many machines is some hundred KB. A longer reply is not read, so the Pi keeps its memory. */
const MAX_PROBE_REPLY = 1024 * 1024;

/** Brother: the "MEM" request gives the program in memory, between % signs */
export async function askBrother(host: string, port: number = MACHINE_PORTS.brother, timeoutMs = ANSWER_TIMEOUT_MS): Promise<FoundMachine | null> {
  const reply = await askOverTcp({
    host,
    port,
    request: brotherCommand('MEM'),
    isComplete: text => BROTHER_PROGRAM_PATTERN.test(text),
    timeoutMs,
  });
  if (!reply) return null;
  return {
    machine: { type: 'brother', name: `Brother ${host}`, host, dataPort: port },
    isConfirmed: true,
    detail: 'The machine answered as a Brother CNC.',
  };
}

/** The serial number in a Haas Q100 reply: ">SERIAL NUMBER, 1234567" */
export function haasSerialOf(reply: string): string | null {
  return HAAS_SERIAL_PATTERN.exec(reply)?.[1] ?? null;
}

/** Haas: Q100 on the query port gives the serial number */
export async function askHaas(host: string, port: number = MACHINE_PORTS.haasQuery, timeoutMs = ANSWER_TIMEOUT_MS): Promise<FoundMachine | null> {
  const request = buildCommandString({ queryStart: 'Q100', label: 'Serial number' });
  const reply = await askOverTcp({
    host,
    port,
    request,
    isComplete: text => text.includes('\n'),
    timeoutMs,
  });
  const serial = reply && haasSerialOf(reply);
  if (!serial) return null;
  return {
    machine: { type: 'haas', name: `Haas ${serial}`, host, dataPort: MACHINE_PORTS.haasData, queryPort: port },
    isConfirmed: true,
    detail: `Serial number ${serial}`,
  };
}

/** The MTConnect agent types that Chatter knows, and a word in the maker name of each */
const AGENT_TYPE_WORDS: [agentType: string, word: string][] = [
  ['dmg_mori', 'dmg'],
  ['dmg_mori', 'mori'],
  ['okuma', 'okuma'],
  ['mazak', 'mazak'],
  ['hurco', 'hurco'],
];

const GENERIC_AGENT_TYPE = 'generic';

/** "DMG MORI" gives "dmg_mori". An unknown maker gives "generic". */
export function agentTypeOf(manufacturer: string | undefined): string {
  const name = (manufacturer ?? '').toLowerCase();
  return AGENT_TYPE_WORDS.find(([, word]) => name.includes(word))?.[0] ?? GENERIC_AGENT_TYPE;
}

interface ProbeDevice {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
}

/** A <Device> element as xml2js gives it: attributes are in `$`, child elements are arrays */
interface ProbeDeviceElement {
  $?: Record<string, string>;
  Description?: { $?: Record<string, string> }[];
}

/** "m:Device" gives "Device", so tags with a namespace prefix read the same */
const withoutNamespacePrefix = (tagName: string) => tagName.replace(/^.*:/, '');

/** The machines (devices) that an MTConnect probe reply lists */
export async function devicesOfProbe(xml: string): Promise<ProbeDevice[]> {
  const document = await parseStringPromise(xml, { tagNameProcessors: [withoutNamespacePrefix] });
  const deviceElements: ProbeDeviceElement[] = document?.MTConnectDevices?.Devices?.[0]?.Device ?? [];
  return deviceElements.map(element => {
    const description = element.Description?.[0]?.$;
    return {
      id: element.$?.id ?? '',
      name: element.$?.name ?? '',
      manufacturer: description?.manufacturer,
      model: description?.model,
    };
  });
}

/** "OKUMA GENOS M560-V" from the maker and model, else the device name, else the address */
function machineNameOf(device: ProbeDevice, host: string): string {
  const makerAndModel = [device.manufacturer, device.model].filter(Boolean).join(' ');
  return makerAndModel || device.name || `MTConnect ${host}`;
}

/** The found machine for an agent. Chatter adds one machine for each agent port, so it takes the first device. */
export function foundMTConnectMachine(host: string, port: number, devices: ProbeDevice[]): FoundMachine | null {
  const [device] = devices;
  if (!device) return null;
  const hasManyDevices = devices.length > 1;
  return {
    machine: {
      type: 'mtconnect',
      name: machineNameOf(device, host),
      host,
      mtConnectPort: port,
      agentType: agentTypeOf(device.manufacturer),
      // An agent with one device needs no device ID
      ...(hasManyDevices ? { mtConnectDeviceId: device.id } : {}),
    },
    isConfirmed: true,
    detail: hasManyDevices
      ? `MTConnect agent on port ${port}. It has ${devices.length} machines; Chatter adds the first one, ${device.name}.`
      : `MTConnect agent on port ${port}`,
  };
}

/** MTConnect: the agent's /probe page lists its machines */
export async function askMTConnect(host: string, port: number, timeoutMs = ANSWER_TIMEOUT_MS): Promise<FoundMachine | null> {
  try {
    // No redirects: the scan must never follow a device to an address outside the shop network
    const response = await fetch(`http://${host}:${port}/probe`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return null;
    const xml = await textUpTo(response, MAX_PROBE_REPLY);
    if (xml === null || !xml.includes(MTCONNECT_PROBE_TAG)) return null;
    return foundMTConnectMachine(host, port, await devicesOfProbe(xml));
  } catch {
    // No answer, a time-out, or a reply that is not XML: there is no MTConnect agent on this port
    return null;
  }
}

/**
 * The text of a reply, or null when it is longer than `maxBytes`. It reads the body in parts and stops at the limit,
 * so a device with a large or endless reply does not fill the memory of the Pi. A longer Content-Length stops it at once.
 */
async function textUpTo(response: Response, maxBytes: number): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** A version as /api/health gives it: "1.2.0", "edge-1a2b3c4" or "development" */
const VERSION_TEXT = /^[A-Za-z0-9.+-]{1,64}$/;
/** A health reply is a short JSON object (bytes). A longer reply is not Chatter. */
const MAX_HEALTH_REPLY = 1024;

/**
 * Chatter: /api/health on port 3001 gives the version, and the random instance name of the server.
 * The instance name tells this Chatter from another. The version is shown only when it has the shape of a version.
 */
export async function askChatter(
  host: string, port = CHATTER_PORT, timeoutMs = ANSWER_TIMEOUT_MS,
): Promise<(FoundChatter & { instance?: string }) | null> {
  try {
    // No redirects: the scan must never follow a device to an address outside the shop network
    const response = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return null;
    const text = await textUpTo(response, MAX_HEALTH_REPLY);
    if (text === null) return null;
    const body = JSON.parse(text) as { status?: unknown; version?: unknown; instance?: unknown };
    if (body.status !== 'ok') return null;
    const version = typeof body.version === 'string' && VERSION_TEXT.test(body.version) ? body.version : 'unknown';
    const instance = typeof body.instance === 'string' && /^[0-9a-f]{16}$/.test(body.instance) ? body.instance : undefined;
    return { host, version, ...(instance && { instance }) };
  } catch {
    return null;
  }
}

/**
 * FANUC: Chatter can ask only with the FOCAS library, so an open FOCAS port is all it knows.
 * The user checks the machine before adding it.
 */
export function maybeFanuc(host: string): FoundMachine {
  return {
    machine: { type: 'fanuc', name: `FANUC ${host}`, host, focasPort: MACHINE_PORTS.fanuc },
    isConfirmed: false,
    detail: `Port ${MACHINE_PORTS.fanuc} is open. FANUC controls use it, but Chatter could not check it.`,
  };
}

/**
 * Siemens: the scan does not open an OPC UA session, because a SINUMERIK control allows only a few,
 * and port 4840 is the port of every OPC UA server. The user checks the machine before adding it.
 */
export function maybeSiemens(host: string): FoundMachine {
  return {
    machine: { type: 'siemens', name: `Siemens ${host}`, host, opcuaPort: MACHINE_PORTS.siemens },
    isConfirmed: false,
    detail: `Port ${MACHINE_PORTS.siemens} (OPC UA) is open. SINUMERIK controls use it, but so do other OPC UA servers.`,
  };
}
