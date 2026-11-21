import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  parseHelperInfo,
  parseNetworkInfo,
  parseUpdateStatus,
  shownUpdateStatus,
  type HelperInfo,
  type HelperRequest,
  type NetworkInfo,
  type UpdateStatus,
} from '@local-chatter/shared';

/** Where the Pi card mounts the update folder in the Chatter container */
export const DEFAULT_UPDATE_FOLDER = '/app/update';
/** The helper moves these two out of the inbox. Chatter never deletes them. */
export const UPDATE_FILE_NAME = 'chatter-update.tar';
export const REQUEST_FILE_NAME = 'request.json';

/** The helper writes these two next to the inbox */
const HELPER_INFO_FILE_NAME = 'helper.json';
const STATUS_FILE_NAME = 'status.json';
/** A newer helper also writes these */
const NETWORK_FILE_NAME = 'network.json';
const HELPER_LOG_NAME = 'helper.log';
/** The helper keeps 2 files of 256 KB. Chatter reads at most this much of them. */
const HELPER_LOG_LIMIT_BYTES = 512 * 1024;
/** The helper writes small JSON files. A larger file is not read. */
const JSON_FILE_LIMIT_BYTES = 64 * 1024;
const INBOX_FOLDER_NAME = 'inbox';

/** Names that Chatter writes first, and renames when they are whole. The helper never reads them. */
const PARTIAL_PREFIX = '.partial-';
const REQUEST_PREFIX = '.request-';
const HIDDEN_NAME_RANDOM_BYTES = 8;

/** Open a file only when it is not there yet, so a write never replaces a file */
const CREATE_NEW_FILE_ONLY = 'wx';

/**
 * The folder that Chatter shares with the update helper on the Pi card.
 * The helper (root, outside Docker) writes status.json and helper.json. Chatter can only read them.
 * Chatter writes the update file and the request into inbox/. On a normal computer the folder is missing.
 */
export class UpdateFolder {
  readonly inbox: string;

  constructor(private readonly folder: string, private readonly now: () => number = Date.now) {
    this.inbox = path.join(folder, INBOX_FOLDER_NAME);
  }

  /** The folder in CHATTER_UPDATE_FOLDER, or the folder that the Pi card mounts */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UpdateFolder {
    return new UpdateFolder(environment.CHATTER_UPDATE_FOLDER?.trim() || DEFAULT_UPDATE_FOLDER);
  }

  /** What the helper wrote about this Pi, or null when there is no helper (a normal computer) */
  async helper(): Promise<HelperInfo | null> {
    const text = await this.readHelperFile(HELPER_INFO_FILE_NAME);
    if (text === null || !(await isFolder(this.inbox))) return null;
    return parseHelperInfo(text);
  }

  /** The status of the last check or install, or null before the first one */
  async status(): Promise<UpdateStatus | null> {
    const text = await this.readHelperFile(STATUS_FILE_NAME);
    const status = text === null ? null : parseUpdateStatus(text);
    return status && shownUpdateStatus(status, this.now());
  }

  /** The network facts of the Pi, or null when the helper does not write them (an older card image) */
  async network(): Promise<NetworkInfo | null> {
    const text = await this.readHelperFile(NETWORK_FILE_NAME);
    return text === null ? null : parseNetworkInfo(text);
  }

  /** The last lines of the helper log (the old file first), or null when there is none (an older card image) */
  async helperLog(limitBytes = HELPER_LOG_LIMIT_BYTES): Promise<string | null> {
    const parts = await Promise.all([`${HELPER_LOG_NAME}.1`, HELPER_LOG_NAME].map(name => readTail(path.join(this.folder, name), limitBytes)));
    if (parts.every(part => part === null)) return null;
    const text = parts.map(part => part ?? '').join('');
    return text.length > limitBytes ? text.slice(text.length - limitBytes) : text;
  }

  /** Ask the helper to check, install, or restart the Pi. The helper sees the request only when it is whole. */
  async writeRequest(request: HelperRequest): Promise<void> {
    const temporaryFile = this.hiddenName(REQUEST_PREFIX);
    try {
      await fs.writeFile(temporaryFile, request, { flag: CREATE_NEW_FILE_ONLY });
      await fs.rename(temporaryFile, path.join(this.inbox, REQUEST_FILE_NAME));
    } catch (error) {
      await this.discard(temporaryFile);
      throw error;
    }
  }

  /** A new hidden name in the inbox, for an update file that is not whole yet */
  newPartialFile(): string {
    return this.hiddenName(PARTIAL_PREFIX);
  }

  /** The whole file came: give it the name that the helper looks for */
  async keepFile(partialFile: string): Promise<void> {
    await fs.rename(partialFile, path.join(this.inbox, UPDATE_FILE_NAME));
  }

  /** A whole update file waits in the inbox for a check */
  async hasUpdateFile(): Promise<boolean> {
    return this.isInInbox(UPDATE_FILE_NAME);
  }

  /** A request waits for the helper. The helper moves it out of the inbox first, when it starts. */
  async hasRequest(): Promise<boolean> {
    return this.isInInbox(REQUEST_FILE_NAME);
  }

  /** Delete a hidden file that is not whole: a half update file, or a request that was not renamed */
  async discard(hiddenFile: string): Promise<void> {
    await fs.rm(hiddenFile, { force: true });
  }

  /** Delete the half files and temporary requests that a stop or a crash left in the inbox */
  async removeLeftovers(): Promise<void> {
    // A normal computer has no inbox, so there is nothing to delete
    const names = await fs.readdir(this.inbox).catch(() => [] as string[]);
    const leftovers = names.filter(isHiddenName);
    await Promise.all(leftovers.map(name => this.discard(path.join(this.inbox, name))));
  }

  /** The free space where the update file goes */
  async freeBytes(): Promise<number> {
    const stats = await fs.statfs(this.inbox);
    return stats.bavail * stats.bsize;
  }

  /** True for a file, not a folder or a link, with this name in the inbox */
  private async isInInbox(name: string): Promise<boolean> {
    return fs.lstat(path.join(this.inbox, name)).then(stats => stats.isFile(), () => false);
  }

  private hiddenName(prefix: string): string {
    return path.join(this.inbox, prefix + randomBytes(HIDDEN_NAME_RANDOM_BYTES).toString('hex'));
  }

  /** The text of a file that the helper wrote, or null when it is not there or too large */
  private async readHelperFile(name: string): Promise<string | null> {
    const file = path.join(this.folder, name);
    const stats = await fs.stat(file).catch(() => null);
    if (!stats?.isFile() || stats.size > JSON_FILE_LIMIT_BYTES) return null;
    return fs.readFile(file, 'utf8').catch(() => null);
  }
}

/** The last `limitBytes` of a file, so a large file never fills the memory. Null when the file is not there. */
async function readTail(file: string, limitBytes: number): Promise<string | null> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limitBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** A name that Chatter writes first: a half update file, or a request that is not renamed yet */
function isHiddenName(name: string): boolean {
  return name.startsWith(PARTIAL_PREFIX) || name.startsWith(REQUEST_PREFIX);
}

async function isFolder(folder: string): Promise<boolean> {
  return fs.stat(folder).then(stats => stats.isDirectory(), () => false);
}
