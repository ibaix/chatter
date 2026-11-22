/**
 * The contract between Chatter and the update helper on the Pi card.
 * Chatter writes one request text into the inbox. The helper (a root script outside Docker) writes
 * status.json and helper.json. Chatter only reads them. See Work item 8 in the plan.
 */

/** The only texts that the helper accepts in request.json. It compares the whole text. */
export const UPDATE_REQUESTS = ['check', 'install'] as const;
export type UpdateRequest = typeof UPDATE_REQUESTS[number];
/** Each request that Chatter can write. "reboot" restarts the Pi (only a helper with the "reboot" capability knows it). */
export type HelperRequest = UpdateRequest | 'reboot';

/**
 * What a newer helper can do more, in helper.json. A helper from an older card image gives none.
 * reboot: it restarts the Pi on a "reboot" request. network: it writes network.json. log: it writes helper.log.
 */
export const HELPER_CAPABILITIES = ['reboot', 'network', 'log'] as const;
export type HelperCapability = typeof HELPER_CAPABILITIES[number];

/**
 * checking, installing: the helper works now.
 * ready: the update file passed the check, and an Admin can install it.
 * refused: the update file did not pass the check (the reason says why).
 * done: the new version runs.
 * failed: the old version runs, and nothing changed.
 * rolled-back: the new version did not start, so the helper put back the old version and its data.
 */
export const UPDATE_STATES = ['checking', 'ready', 'refused', 'installing', 'done', 'failed', 'rolled-back'] as const;
export type UpdateState = typeof UPDATE_STATES[number];

/** The helper works now, so Chatter refuses a new request */
export function isBusy(state: UpdateState): boolean {
  return state === 'checking' || state === 'installing';
}

/**
 * The step that a busy helper does now. The helper writes it in status.json (STEPS in update-chatter.sh).
 * tools/guardrails/updateSteps.test.ts makes sure that the two lists are the same.
 * A check: copying, listing, signature, space, files, images.
 * An install: verifying, backing-up, loading (with "part of parts": the image), starting, health.
 * A helper from an older card image writes no step.
 */
export const UPDATE_STEPS = [
  'copying', 'listing', 'signature', 'space', 'files', 'images',
  'verifying', 'backing-up', 'loading', 'starting', 'health',
] as const;
export type UpdateStep = typeof UPDATE_STEPS[number];

/** The most parts that a step can have. An update file has at most 3 images. */
const STEP_PARTS_LIMIT = 999;

/** The processor types that an update file can be for */
export const UPDATE_ARCHES = ['amd64', 'arm64', 'armv7'] as const;
export type UpdateArch = typeof UPDATE_ARCHES[number];

/** A release version, such as "1.2.0". Edge builds ("edge-<commit>") cannot update. */
export const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** The largest update file: 600 MiB, which is 629145600 bytes. The bash helper uses the same number. */
export const UPDATE_FILE_LIMIT_BYTES = 600 * 1024 * 1024;

/** A busy helper writes a new heartbeat this often */
export const HELPER_HEARTBEAT_MS = 30_000;

/** A busy helper with no heartbeat for this long has died, so it counts as failed */
export const HELPER_SILENCE_LIMIT_MS = 2 * 60_000;

/**
 * The contents of /opt/chatter/update/status.json.
 * The helper writes `version` only after the version passed the RELEASE_VERSION check.
 */
export interface UpdateStatus {
  state: UpdateState;
  /** The version of the update file, when the helper knows it */
  version?: string;
  /** Why the helper refused, failed, or rolled back. It never holds text from the update file. */
  reason?: string;
  /** UTC time, as `date -u +%Y-%m-%dT%H:%M:%SZ` writes it. The helper updates it while it works. */
  heartbeat: string;
  /** The free space on the card. The helper writes it in each status. */
  freeBytes: number;
  /** After done: the space that the clean up gave back */
  freedBytes?: number;
  /** While the helper works: the step that it does now */
  step?: UpdateStep;
  /** With a step: which part of the step (for example image 2 of 3) */
  part?: number;
  parts?: number;
  /** While the helper works: the UTC time when this check or install started */
  startedAt?: string;
}

/**
 * The contents of /opt/chatter/update/helper.json. The helper writes it at each start of the Pi.
 * When the file is there, Chatter knows that it runs on a card with the helper.
 */
export interface HelperInfo {
  /** The processor type of the Pi, so Chatter downloads the right update file */
  arch: UpdateArch;
  /** What this helper can do more. Only a helper from a newer card image writes it. */
  capabilities?: HelperCapability[];
}

/** One address of the Pi in network.json */
export interface PiAddress {
  /** "eth0" or "wlan0" */
  interface: string;
  /** "192.168.1.20/24" */
  address: string;
}

/**
 * The contents of /opt/chatter/update/network.json. The helper writes it at each start of the Pi and each 10 minutes.
 * Only a helper from a newer card image writes it.
 */
export interface NetworkInfo {
  hostname?: string;
  /** "chatter.local" */
  localName?: string;
  addresses: PiAddress[];
  gateway?: string;
  /** SSH runs on the Pi */
  ssh: boolean;
  /** UTC time */
  updatedAt: string;
}

/**
 * Reads status.json. Gives null if the text is not a status that the helper could write.
 * The step fields only help the page, so a step field that is not correct is dropped, and the status stays.
 */
export function parseUpdateStatus(text: string): UpdateStatus | null {
  const data = parseObject(text);
  if (!data) return null;
  const { state, version, reason, heartbeat, freeBytes, freedBytes } = data;
  if (!isOneOf(state, UPDATE_STATES) || !isTime(heartbeat) || !isByteCount(freeBytes)) return null;
  if (reason !== undefined && typeof reason !== 'string') return null;
  if (freedBytes !== undefined && !isByteCount(freedBytes)) return null;
  return {
    state,
    heartbeat,
    freeBytes,
    ...(isReleaseVersion(version) && { version }),
    ...(reason !== undefined && { reason }),
    ...(freedBytes !== undefined && { freedBytes }),
    ...parseProgress(data),
  };
}

type ProgressFields = Pick<UpdateStatus, 'step' | 'part' | 'parts' | 'startedAt'>;

/** The start time, the step, and its part only when the step is known and 1 <= part <= parts <= STEP_PARTS_LIMIT */
function parseProgress({ step, part, parts, startedAt }: Record<string, unknown>): ProgressFields {
  const start = isTime(startedAt) ? { startedAt } : {};
  if (!isOneOf(step, UPDATE_STEPS)) return start;
  if (!isPartCount(part) || !isPartCount(parts) || part > parts) return { ...start, step };
  return { ...start, step, part, parts };
}

function isPartCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= STEP_PARTS_LIMIT;
}

/** Reads helper.json. Gives null if the text is not what the helper writes. An unknown capability is dropped. */
export function parseHelperInfo(text: string): HelperInfo | null {
  const data = parseObject(text);
  if (!data) return null;
  const { arch, capabilities } = data;
  if (!isOneOf(arch, UPDATE_ARCHES)) return null;
  if (!Array.isArray(capabilities)) return { arch };
  return { arch, capabilities: capabilities.filter((item): item is HelperCapability => isOneOf(item, HELPER_CAPABILITIES)) };
}

const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const INTERFACE_NAME = /^[A-Za-z0-9._-]{1,15}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ADDRESS_WITH_PREFIX = /^((25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/\d{1,2}|[0-9a-fA-F:]{2,39}\/\d{1,3})$/;
const MAX_ADDRESSES = 8;

/** Reads network.json. Gives null if the text is not what the helper writes. A value with the wrong shape is dropped. */
export function parseNetworkInfo(text: string): NetworkInfo | null {
  const data = parseObject(text);
  if (!data || !isTime(data.updatedAt) || typeof data.ssh !== 'boolean' || !Array.isArray(data.addresses)) return null;
  const { hostname, localName, gateway } = data;
  const addresses = data.addresses
    .filter((item): item is PiAddress => isPiAddress(item))
    .slice(0, MAX_ADDRESSES)
    .map(({ interface: name, address }) => ({ interface: name, address }));
  return {
    ...(typeof hostname === 'string' && HOST_NAME.test(hostname) && { hostname }),
    ...(typeof localName === 'string' && HOST_NAME.test(localName.replace(/\.local$/, '')) && localName.endsWith('.local') && { localName }),
    addresses,
    ...(typeof gateway === 'string' && IPV4.test(gateway) && { gateway }),
    ssh: data.ssh,
    updatedAt: data.updatedAt,
  };
}

function isPiAddress(item: unknown): item is PiAddress {
  if (typeof item !== 'object' || item === null) return false;
  const { interface: name, address } = item as Record<string, unknown>;
  return typeof name === 'string' && INTERFACE_NAME.test(name) && typeof address === 'string' && ADDRESS_WITH_PREFIX.test(address);
}

/** The status to show: a busy helper that is silent for too long has died, so it counts as failed */
export function shownUpdateStatus(status: UpdateStatus, now: number): UpdateStatus {
  const silentMs = now - Date.parse(status.heartbeat);
  if (isBusy(status.state) && silentMs > HELPER_SILENCE_LIMIT_MS) {
    return { ...status, state: 'failed', reason: 'The update helper stopped. See the helper log in Settings > Diagnostics, or run: journalctl -u chatter-update' };
  }
  return status;
}

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_VERSION.test(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
