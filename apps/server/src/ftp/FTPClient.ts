import net from 'net';
import { Readable, Writable } from 'stream';
import * as ftp from 'basic-ftp';
import { ftpErrorMessage } from './ftpErrorMessage.js';
import { FILE_TREE_ENTRY_LIMIT } from '@local-chatter/shared';
import { createLogger } from '../logging/logger.js';
import { sizeText } from '../http/sizeText.js';
import { MachineBusyError, SessionQueue } from './sessionQueue.js';
import type { FileTree, FTPConfig, FTPFileInfo, FTPTreeNode, FTPUploadFile, FTPUploadResult } from '../types/index.js';

const DEFAULT_FTP_PORT = 21;
const DEFAULT_FTP_USER = 'anonymous';
/** The time that the FTP client waits for the machine. This is also the default of basic-ftp. */
const DEFAULT_FTP_TIMEOUT_MS = 30_000;
const DEFAULT_TREE_DEPTH = 2;
/**
 * The most folder levels that one tree request walks. Each level costs a LIST on the machine.
 * The web app asks for 2 levels, and CNC program folders are not deeper than this.
 */
export const MAX_TREE_DEPTH = 5;
/** The most entries (files and folders) in one tree, so a very large or rogue FTP server cannot fill the memory */
export const MAX_TREE_ENTRIES = FILE_TREE_ENTRY_LIMIT;
const ROOT_PATH = '/';
/**
 * The most bytes of one folder listing. A listing line has about 60 bytes, so this holds more than
 * MAX_TREE_ENTRIES lines. A rogue FTP server cannot fill the memory of a Pi with a listing that has no end.
 */
export const MAX_FOLDER_LIST_BYTES = 1024 * 1024;
const MAX_FOLDER_LIST_MB = MAX_FOLDER_LIST_BYTES / 1024 / 1024;
/** The most folders that one tree walk opens. Each folder costs some commands and a LIST on the machine. */
export const MAX_TREE_FOLDERS = 200;
/**
 * One tree walk stops after this time, and keeps what it read. A slow machine can take some time for each folder,
 * so a normal walk of many folders can take some time.
 */
export const TREE_WALK_TIME_LIMIT_MS = 120_000;
/** One folder list of listFiles, and the check for a file before an upload, stops after this time */
export const FOLDER_LIST_TIME_LIMIT_MS = 60_000;
const FOLDER_LIST_TOO_LONG_MESSAGE = `The folder list on the machine is too long. Chatter reads at most ${MAX_FOLDER_LIST_MB} MB of it.`;
const FOLDER_LIST_TOO_SLOW_MESSAGE = 'The folder list on the machine took too long.';

/** The raw RETR stops when the machine stops in the middle of a file */
const DOWNLOAD_STALLED_MESSAGE = 'The machine stopped sending the file. Try again.';
/**
 * The most bytes of one download. CNC programs are much smaller (a control holds some MB at most), but a program on a
 * data server can be large. A rogue FTP server cannot send a file with no end.
 */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/**
 * One download stops after this time. A machine that sends one byte just before each timeout cannot keep the
 * download open for ever. A slow control sends about 50 KB each second, so 64 MB takes about 22 minutes.
 */
const DOWNLOAD_TIME_LIMIT_MS = 30 * 60_000;
/**
 * One upload (one file, or one batch) stops after this time. An upload keeps the turn of the machine, so a control
 * that never confirms an upload cannot block the other file tasks of the machine for ever. One upload request has at
 * most 32 MB. At 50 KB each second, that takes about 11 minutes.
 */
const UPLOAD_TIME_LIMIT_MS = 30 * 60_000;
/**
 * The most walks of different trees that wait for one machine. A walk of another tree that comes then fails at once.
 * Each role can ask for a tree, and each walk can take minutes. This limit is less than MAX_WAITING_TASKS, so tree
 * walks cannot fill the queue, and the sends and downloads of an Operator can still wait for their turn.
 */
const MAX_WAITING_TREE_WALKS = 2;
/**
 * After a clean end of the data connection, the raw RETR waits this long for the reply to RETR (usually 226).
 * Some old, simple FTP servers never send this reply. Then the file is complete without it. The wait is never
 * longer than the FTP timeout.
 */
export const REPLY_AFTER_DATA_WAIT_MS = 3_000;
/**
 * The download waits this long for the reply to SIZE. Some limited servers do not answer a command that they do not
 * know, and the FTP timeout (30 s) is too long to wait before each download.
 */
export const SIZE_REPLY_WAIT_MS = 3_000;
/**
 * The raw LIST waits this long for its reply (usually 226) after a clean end of the data connection, and for more data
 * after its reply or after its first byte. Some old servers send no reply, and some do not close the data connection.
 * A tree walk waits once for each folder, so this time is shorter than the wait of the raw RETR.
 */
const REPLY_AFTER_LIST_WAIT_MS = 1_000;
/**
 * The raw RETR and the raw LIST stop when their data connection does not open in this time, and use the
 * fallback of basic-ftp. On a shop network a connection opens in a few milliseconds. The FTP timeout (30 s)
 * would come for each folder of a tree walk, so this time is shorter.
 */
const RAW_DATA_CONNECT_TIMEOUT_MS = 5_000;

/**
 * "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)": four address bytes, then the port as two bytes.
 * Some servers send no parentheses, and some send a byte as a signed number (for example -17 for 239).
 * Only the port is used: the data connection goes to the host of the control connection.
 * The match starts only at the start of a number, so a long number costs no backtracking.
 */
const PASV_REPLY_PATTERN = /(?<![-\d])(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)/;
const BYTE_SIZE = 256;
/** As basic-ftp does, keep the low 8 bits of each port byte. So -17 gives 239, and 300 gives 44. */
const BYTE_MASK = 0xff;

const ALREADY_EXISTS_MARKER = 'already exists';

const UNIX_ENTRY_FIELD_COUNT = 9;
const UNIX_SIZE_FIELD = 4;
const UNIX_NAME_FIRST_FIELD = 8;
const DOS_ENTRY_FIELD_COUNT = 4;
const DOS_SIZE_FIELD = 2;
const DOS_NAME_FIRST_FIELD = 3;

export interface RawListEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** The entries that one tree walk can still add */
interface TreeWalk {
  entriesLeft: number;
  foldersLeft: number;
  /** Why the walk left out an entry or a folder. Undefined when the tree is complete. */
  cutReason?: TreeCutReason;
  /**
   * Set when the walk must open no more folders: after its time limit, or after a listing that is too long.
   * After a listing that is too long, the machine can still send its reply to that LIST,
   * and that late reply must not go to the next command.
   */
  stopReason?: TreeCutReason;
}

type TreeCutReason = 'entries' | 'folders' | 'time' | 'longList' | 'cutList' | 'login';

function cutWalk(walk: TreeWalk, reason: TreeCutReason): void {
  walk.cutReason ??= reason;
}

/** Cut the walk, and open no more folders */
function stopWalk(walk: TreeWalk, reason: TreeCutReason): void {
  cutWalk(walk, reason);
  walk.stopReason ??= reason;
}

/** The reason why the walk must open no more folders, or undefined when it can go on */
function stopReasonOf(walk: TreeWalk): TreeCutReason | undefined {
  if (walk.stopReason) return walk.stopReason;
  if (walk.entriesLeft <= 0) return 'entries';
  if (walk.foldersLeft <= 0) return 'folders';
  return undefined;
}

/** One folder listing, whether it was longer than MAX_FOLDER_LIST_BYTES, and whether it ended before it was complete */
interface FolderListing {
  entries: RawListEntry[];
  isTooLong: boolean;
  isCut: boolean;
}

/**
 * The text of a raw LIST, whether Chatter stopped it at MAX_FOLDER_LIST_BYTES, and whether it ended before it was
 * complete (an error reply, or a stall after some bytes, that cut a line)
 */
interface RawListing {
  text: string;
  isTooLong: boolean;
  isCut: boolean;
}

/** A folder list that was too long or too slow. The caller cannot know if a file is in the folder. */
class FolderListLimitError extends Error {}

/**
 * A raw RETR error after which the fallback cannot help, because a second RETR would end the same way:
 * - the machine refused the RETR with an error reply, for example "550 No such file". This is a clear answer about
 *   the file.
 * - the file is larger than the byte limit.
 */
class NoFallbackError extends Error {}

/**
 * "425 Cannot open data connection": the machine could not use the data connection of the raw RETR. This is not an
 * answer about the file, so the fallback of basic-ftp can still work.
 */
const CANNOT_OPEN_DATA_CONNECTION = 425;

/** A folder that the tree walk still has to list, and the list to fill with its entries */
interface TreeFolder {
  path: string;
  nodes: FTPTreeNode[];
}

type BatchFileOutcome = FTPUploadResult['success'][number] | FTPUploadResult['failed'][number];

/** The place where the raw RETR writes the file, and the number of bytes that it wrote */
interface DownloadSink {
  destination: Writable;
  bytesWritten: number;
}

/** The limits of one download (`maxBytes`, `timeLimitMs`) and of one upload. Tests set small limits. */
export interface DownloadLimits {
  maxBytes: number;
  timeLimitMs: number;
  uploadTimeLimitMs: number;
}

const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = {
  maxBytes: MAX_DOWNLOAD_BYTES, timeLimitMs: DOWNLOAD_TIME_LIMIT_MS, uploadTimeLimitMs: UPLOAD_TIME_LIMIT_MS,
};

/** A tree walk that one or more callers wait for */
interface SharedTreeWalk {
  tree: Promise<FileTree>;
  /** Stops the walk when each caller left */
  stop: AbortController;
  callers: number;
  /** True until the walk gets its turn on the machine */
  isWaiting: boolean;
}

/**
 * One stop for a task: the signal of the caller, and a time limit. The time limit starts with startTimeLimit, when the
 * task gets its turn, so the wait for the turn does not count. Call `end` when the task ends.
 */
class TaskStop {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly stopOnSignal = () => this.controller.abort(this.callerSignal?.reason);

  constructor(callerSignal: AbortSignal | undefined) {
    this.callerSignal = callerSignal;
    onAbort(callerSignal, this.stopOnSignal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  startTimeLimit(timeLimitMs: number, tooSlowError: () => Error): void {
    this.timer = setTimeout(() => this.controller.abort(tooSlowError()), timeLimitMs);
  }

  /** The reason of the stop when the task stopped, else `err`. After a stop, the error of the closed connection tells less. */
  reasonOr(err: unknown): unknown {
    return this.controller.signal.aborted ? this.controller.signal.reason : err;
  }

  end(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener('abort', this.stopOnSignal);
  }
}

interface PassiveAddress {
  host: string;
  port: number;
  reply: ftp.FTPResponse;
}

/**
 * Split a remote file path into its folder and its file name, so that an
 * existence check lists the right folder (not the root).
 */
export function parseFilePath(filePath: string): { dirPath: string; fileName: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash < 0) {
    return { dirPath: ROOT_PATH, fileName: filePath };
  }
  return {
    dirPath: '/' + filePath.substring(0, lastSlash),
    fileName: filePath.substring(lastSlash + 1)
  };
}

/**
 * Parse raw FTP LIST output into file entries.
 * Handles Unix, DOS, and plain file name formats:
 *   Unix:      drwxr-xr-x  2 user group 4096 Jan  1 12:00 filename
 *   DOS dir:   01-01-24  12:00PM  <DIR>  foldername
 *   DOS file:  01-01-24  12:00PM  12345  filename.txt
 *   Plain:     filename
 */
export function parseRawList(rawListing: string): RawListEntry[] {
  return rawListing
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(parseRawListLine)
    .filter((entry): entry is RawListEntry => entry !== undefined && isRealEntry(entry.name));
}

function parseRawListLine(line: string): RawListEntry | undefined {
  if (line.includes('<DIR>')) return parseDosDirectoryLine(line);
  if (/^\d{2}-\d{2}-\d{2}/.test(line)) return parseDosFileLine(line);
  if (/^[d\-lrwxs]/.test(line)) return parseUnixLine(line);
  return plainFileEntry(line);
}

function parseDosDirectoryLine(line: string): RawListEntry | undefined {
  const match = line.match(/<DIR>\s+(.+)$/);
  return match ? { name: match[1].trim(), isDir: true, size: 0 } : undefined;
}

function parseDosFileLine(line: string): RawListEntry | undefined {
  const fields = line.split(/\s+/);
  if (fields.length < DOS_ENTRY_FIELD_COUNT) return undefined;
  return {
    name: fields.slice(DOS_NAME_FIRST_FIELD).join(' '),
    isDir: false,
    size: parseInt(fields[DOS_SIZE_FIELD]) || 0
  };
}

function parseUnixLine(line: string): RawListEntry {
  const fields = line.split(/\s+/);
  // A plain file name can start with one of the Unix mode letters, so too few fields means a plain name
  if (fields.length < UNIX_ENTRY_FIELD_COUNT) return plainFileEntry(line);
  return {
    name: fields.slice(UNIX_NAME_FIRST_FIELD).join(' '),
    isDir: line.startsWith('d'),
    size: parseInt(fields[UNIX_SIZE_FIELD]) || 0
  };
}

function plainFileEntry(line: string): RawListEntry {
  return { name: line, isDir: false, size: 0 };
}

function isRealEntry(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..';
}

/**
 * FTP sends a path in a command line, so a line break would start a second command, for example DELE.
 * The routes refuse such a path first. This check is for each other caller, and for the raw RETR write,
 * which does not go through the check of basic-ftp. \p{Cc} is each control character, CR, LF and NUL included.
 */
function assertSafeFtpArgument(argument: string): void {
  if (/\p{Cc}/u.test(argument)) {
    throw new Error(`The path ${JSON.stringify(argument)} cannot have a line break or another control character`);
  }
}

/** basic-ftp wants paths without a leading "./" or "/" */
function toRelativeRemotePath(remotePath: string): string {
  if (remotePath.startsWith('./')) return remotePath.substring(2);
  if (remotePath.startsWith('/')) return remotePath.substring(1);
  return remotePath;
}

function joinRemotePath(dirPath: string, name: string): string {
  return dirPath === ROOT_PATH ? `/${name}` : `${dirPath}/${name}`;
}

const log = createLogger('ftp');

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

/**
 * True when basic-ftp stopped a list at its `maxListingBytes`. basic-ftp gives no error code for this,
 * so this reads the message of its StringWriter. A test with the real basic-ftp checks this message.
 */
function isListingTooLong(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('StringWriter: Maximum bytes exceeded');
}

/** Run `work`. When it takes longer than `timeLimitMs`, run `onTimeUp`, then close the client, so the work stops. */
async function closeClientAfter<T>(
  client: ftp.Client,
  { timeLimitMs, onTimeUp }: { timeLimitMs: number; onTimeUp: () => void },
  work: () => Promise<T>
): Promise<T> {
  const timer = setTimeout(() => {
    onTimeUp();
    client.close();
  }, timeLimitMs);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

/** basic-ftp's list of one folder, with a time limit. basic-ftp itself stops at MAX_FOLDER_LIST_BYTES. */
async function listFolderWithLimits(client: ftp.Client, path: string): Promise<ftp.FileInfo[]> {
  let isTimeUp = false;
  try {
    return await closeClientAfter(client, { timeLimitMs: FOLDER_LIST_TIME_LIMIT_MS, onTimeUp: () => { isTimeUp = true; } }, () => client.list(path));
  } catch (err) {
    if (isTimeUp) throw new FolderListLimitError(FOLDER_LIST_TOO_SLOW_MESSAGE, { cause: err });
    if (isListingTooLong(err)) throw new FolderListLimitError(FOLDER_LIST_TOO_LONG_MESSAGE, { cause: err });
    throw err;
  }
}

/** The complete lines of a listing. When the listing can be cut, its last line can be cut in two, so it is left out. */
function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

function alreadyExistsMessage(remotePath: string): string {
  return `File "${remotePath}" ${ALREADY_EXISTS_MARKER}. Enable overwrite to replace it.`;
}

/** Run `stop` when the signal aborts, also when it aborted before this call */
function onAbort(signal: AbortSignal | undefined, stop: () => void): void {
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
}

const MS_IN_MINUTE = 60_000;
const MS_IN_SECOND = 1_000;

/** "30 minutes", or the number of seconds when the time is not a whole number of minutes */
function durationText(ms: number): string {
  const minutes = ms / MS_IN_MINUTE;
  if (Number.isInteger(minutes)) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const seconds = ms / MS_IN_SECOND;
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

function downloadTooLargeError(maxBytes: number): Error {
  return new NoFallbackError(`The file on the machine is too large. Chatter downloads at most ${sizeText(maxBytes)}.`);
}

function downloadTooSlowError(timeLimitMs: number): Error {
  return new Error(`The download took too long. Chatter stops a download after ${durationText(timeLimitMs)}.`);
}

function uploadTooSlowError(timeLimitMs: number): Error {
  return new Error(`The upload took too long. Chatter stops an upload after ${durationText(timeLimitMs)}.`);
}

/**
 * A stream that gives each chunk to `destination`, and fails when more than `maxBytes` come. It waits for the
 * 'drain' of `destination`, so a slow destination slows the transfer. It does not end `destination`.
 */
function limitBytes(destination: Writable, maxBytes: number): Writable {
  let byteCount = 0;
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      byteCount += chunk.length;
      if (byteCount > maxBytes) done(downloadTooLargeError(maxBytes));
      else if (destination.write(chunk)) done();
      else destination.once('drain', () => done());
    },
  });
}

async function toBuffer(source: Buffer | string | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === 'string') return Buffer.from(source);
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Binary mode stops line ending changes. Some machine FTP servers reject TYPE I, so the transfer is tried anyway. */
async function trySetBinaryMode(client: ftp.Client): Promise<void> {
  try {
    await client.send('TYPE I');
  } catch {
    // The server does not support TYPE I; continue in its default mode
  }
}

/** "213 1234": the reply to SIZE. Only a plain number counts. */
const SIZE_REPLY_PATTERN = /^213 (\d+)\s*$/;

/**
 * The address of the passive data connection. A rogue machine can name any host in its PASV reply,
 * so Chatter would connect to a host of its choice. So the host is always the address of the control
 * connection (the machine), and only the port comes from the reply. EPSV in basic-ftp does the same.
 */
async function requestPassiveAddress(ftpContext: ftp.FTPContext): Promise<PassiveAddress> {
  const reply = await ftpContext.request('PASV');
  const port = passivePort(reply.message);
  return { host: controlConnectionHost(ftpContext), port, reply };
}

/** The data port in a PASV reply. Port 0 is not a port that a client can connect to. */
function passivePort(message: string): number {
  const match = message.match(PASV_REPLY_PATTERN);
  if (!match) {
    throw new Error(`Chatter cannot read the port in the PASV reply: ${JSON.stringify(message)}`);
  }
  const [portHigh, portLow] = match.slice(5).map(byte => parseInt(byte, 10) & BYTE_MASK);
  const port = portHigh * BYTE_SIZE + portLow;
  if (port === 0) {
    throw new Error('The PASV reply gives port 0. Chatter cannot open a data connection to port 0.');
  }
  return port;
}

/** The address that the control connection is connected to, as an IPv4 address when the socket is dual-stack */
function controlConnectionHost(ftpContext: ftp.FTPContext): string {
  const host = ftpContext.socket.remoteAddress;
  if (host === undefined) {
    throw new Error('The control connection is closed, so the data connection cannot open');
  }
  return host.replace(/^::ffff:/i, '');
}

/**
 * Open a data connection to the machine. The attempt stops after `timeoutMs` (0 means no limit),
 * and then the socket is destroyed. A socket error keeps its code.
 */
function openDataSocket({ host, port, timeoutMs, family }: {
  host: string; port: number; timeoutMs: number; family?: number;
}): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const onError = (err: Error) => {
      err.message = `The passive data connection did not open: ${err.message}`;
      reject(err);
    };
    const onTimeout = () => {
      socket.destroy();
      reject(new Error(`Timeout: the passive data connection to ${host}:${port} did not open`));
    };
    socket.setTimeout(timeoutMs);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
    socket.connect({ port, host, family }, () => {
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      resolve(socket);
    });
  });
}

/**
 * Open the data connection of a basic-ftp transfer, as basic-ftp does for its own PASV and EPSV.
 * The connection attempt stops after the FTP timeout. When the connection opens, basic-ftp takes it,
 * and from then on basic-ftp handles its errors and its timeout.
 */
async function connectDataSocket(ftpContext: ftp.FTPContext, { host, port }: { host: string; port: number }): Promise<void> {
  // Chatter always connects with "secure: false". This code opens a plain socket, so it must not run over TLS.
  if (ftpContext.hasTLS) {
    throw new Error('Chatter does not support FTP over TLS for the PASV data connection');
  }
  // The setter adds the error handlers of basic-ftp
  ftpContext.dataSocket = await openDataSocket({ host, port, timeoutMs: ftpContext.timeout, family: ftpContext.ipFamily });
}

/** The PASV transfer strategy of basic-ftp, with the data connection to the machine host */
async function enterPassiveModeOnControlHost(ftpContext: ftp.FTPContext): Promise<ftp.FTPResponse> {
  const { host, port, reply } = await requestPassiveAddress(ftpContext);
  await connectDataSocket(ftpContext, { host, port });
  return reply;
}

/**
 * Make basic-ftp accept a PASV reply that names another host, as a machine behind NAT can send. The data
 * connection goes to the machine host, as the raw PASV code of FTPClient does. The default of basic-ftp
 * refuses such a reply, so the upload fails. EPSV stays first. As in basic-ftp, the client keeps the first
 * strategy that works for the next transfers.
 */
function useMachineHostForTransfers(client: ftp.Client): void {
  client.prepareTransfer = async ftpContext => {
    let lastError: unknown;
    for (const strategy of [ftp.enterPassiveModeIPv6, enterPassiveModeOnControlHost]) {
      try {
        const reply = await strategy(ftpContext);
        client.prepareTransfer = strategy;
        return reply;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
}

/** A task that did not start because the machine is busy keeps its own text, with no "FTP error" in front */
function rethrowIfBusy(err: unknown): void {
  if (err instanceof MachineBusyError) throw err;
}

/**
 * Reusable FTP client for CNC machine file operations.
 * Handles file listing, tree browsing, downloads, uploads, and deletes.
 * Compatible with limited FTP servers (like Speedio) via manual PASV mode.
 * Many CNC FTP servers accept only one session, so the tasks of one client run one at a time (see SessionQueue).
 * Each machine has one client, so each machine has at most one FTP control connection open.
 */
export class FTPClient {
  private host: string;
  private port: number;
  private user: string;
  private password: string;
  private readonly timeoutMs: number;
  private readonly downloadLimits: DownloadLimits;
  /** The tree walks that wait or run now, by depth and path. A request for the same tree waits for the same walk. */
  private readonly treeWalks = new Map<string, SharedTreeWalk>();
  /** One task at a time: each task opens its control connection only in its turn, and closes it before the next */
  private readonly sessions = new SessionQueue();

  constructor({
    host, port = DEFAULT_FTP_PORT, user = DEFAULT_FTP_USER, password = '', timeoutMs = DEFAULT_FTP_TIMEOUT_MS
  }: FTPConfig, downloadLimits: Partial<DownloadLimits> = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.downloadLimits = { ...DEFAULT_DOWNLOAD_LIMITS, ...downloadLimits };
  }

  /** Change connection settings (for example after a machine config change) */
  updateConfig({ host, port, user, password }: Partial<FTPConfig>): void {
    if (host !== undefined) this.host = host;
    if (port !== undefined) this.port = port;
    if (user !== undefined) this.user = user;
    if (password !== undefined) this.password = password;
  }

  /** `signal` stops the list, also while it waits for its turn, for example when the browser leaves */
  async listFiles(path = ROOT_PATH, signal?: AbortSignal): Promise<FTPFileInfo[]> {
    try {
      assertSafeFtpArgument(path);
      const list = await this.withConnection({ verbose: false, signal }, client => listFolderWithLimits(client, path));
      return list.map(item => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        modifiedAt: item.modifiedAt,
        path: joinRemotePath(path, item.name)
      }));
    } catch (err) {
      rethrowIfBusy(err);
      throw new Error(ftpErrorMessage(err, this.host, this.port), { cause: err });
    }
  }

  async getFileTree(path = ROOT_PATH, depth = DEFAULT_TREE_DEPTH): Promise<FTPTreeNode[]> {
    return (await this.readFileTree(path, depth)).nodes;
  }

  /**
   * The file tree, and whether the walk cut it short: at MAX_TREE_ENTRIES entries, at MAX_TREE_FOLDERS folders,
   * at TREE_WALK_TIME_LIMIT_MS, after a folder listing that is too long ('longList'), after a folder listing that
   * ended before it was complete ('cutList'), or when a new login during the walk failed ('login').
   * The depth limit does not count as a cut.
   *
   * Requests for the same tree share one walk. `signal` takes this caller out, for example when the browser leaves.
   * The walk stops when each caller left. While a walk of one tree waits for its turn, a walk of another tree fails at
   * once with a MachineBusyError, so walks cannot fill the queue of the machine.
   */
  async readFileTree(path = ROOT_PATH, depth = DEFAULT_TREE_DEPTH, signal?: AbortSignal): Promise<FileTree> {
    signal?.throwIfAborted();
    // The walk stops at MAX_TREE_DEPTH, so a deeper request is the same walk
    const walkDepth = Math.min(depth, MAX_TREE_DEPTH);
    const key = `${walkDepth}:${path}`;
    const walk = this.treeWalks.get(key) ?? this.startTreeWalk(key, path, walkDepth);
    return this.joinTreeWalk(key, walk, signal);
  }

  private startTreeWalk(key: string, path: string, depth: number): SharedTreeWalk {
    const willWait = this.sessions.hasRunningTask;
    const waitingWalks = [...this.treeWalks.values()].filter(other => other.isWaiting).length;
    if (willWait && waitingWalks >= MAX_WAITING_TREE_WALKS) throw SessionQueue.busyError();
    const stop = new AbortController();
    const walk: SharedTreeWalk = {
      stop,
      callers: 0,
      isWaiting: willWait,
      tree: this.walkFileTree(path, depth, { signal: stop.signal, onTurn: () => { walk.isWaiting = false; } })
        .finally(() => this.forgetTreeWalk(key, walk)),
    };
    this.treeWalks.set(key, walk);
    return walk;
  }

  /** A new request for the tree of `key` starts a new walk. A late end of an old walk does not remove a newer walk. */
  private forgetTreeWalk(key: string, walk: SharedTreeWalk): void {
    if (this.treeWalks.get(key) === walk) this.treeWalks.delete(key);
  }

  /** Wait for the shared walk. `signal` takes this caller out. When each caller left, the walk stops. */
  private joinTreeWalk(key: string, walk: SharedTreeWalk, signal: AbortSignal | undefined): Promise<FileTree> {
    walk.callers += 1;
    return new Promise((resolve, reject) => {
      const leave = () => {
        walk.callers -= 1;
        if (walk.callers === 0) {
          this.forgetTreeWalk(key, walk);
          walk.stop.abort(signal?.reason);
        }
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', leave, { once: true });
      walk.tree.then(tree => {
        signal?.removeEventListener('abort', leave);
        resolve(tree);
      }, (err: unknown) => {
        signal?.removeEventListener('abort', leave);
        reject(err as Error);
      });
    });
  }

  private async walkFileTree(
    path: string,
    depth: number,
    { signal, onTurn }: { signal: AbortSignal; onTurn: () => void }
  ): Promise<FileTree> {
    const walk: TreeWalk = { entriesLeft: MAX_TREE_ENTRIES, foldersLeft: MAX_TREE_FOLDERS };
    try {
      assertSafeFtpArgument(path);
      if (depth <= 0) {
        return { nodes: [], isCutShort: false };
      }
      const nodes = await this.withConnection({ verbose: false, signal, onTurn }, client => closeClientAfter(
        client,
        { timeLimitMs: TREE_WALK_TIME_LIMIT_MS, onTimeUp: () => stopWalk(walk, 'time') },
        () => this.buildTree(client, { path, depth, walk })
      ));
      if (walk.cutReason) {
        log.warn(this.treeCutMessage(walk.cutReason), { path });
      }
      return { nodes, isCutShort: walk.cutReason !== undefined };
    } catch (err) {
      rethrowIfBusy(err);
      throw new Error(ftpErrorMessage(err, this.host, this.port), { cause: err });
    }
  }

  /**
   * Download one file to `writableStream`. The download stops at the time limit and at the byte limit
   * (DOWNLOAD_TIME_LIMIT_MS and MAX_DOWNLOAD_BYTES), and then closes its connections to the machine.
   * The time limit starts when the download gets its turn. `signal` stops the download in the same way, for example
   * when the user cancels it. While the download waits for its turn, `signal` takes it out of the queue.
   */
  async downloadFile(filePath: string, writableStream: Writable, signal?: AbortSignal): Promise<void> {
    const remotePath = toRelativeRemotePath(filePath);
    const { maxBytes, timeLimitMs } = this.downloadLimits;
    // One stop for the time limit and for the signal of the caller: it closes the client and the raw data socket
    const stop = new TaskStop(signal);
    const onTurn = () => stop.startTimeLimit(timeLimitMs, () => downloadTooSlowError(timeLimitMs));
    try {
      assertSafeFtpArgument(remotePath);
      await this.withConnection({ verbose: true, signal: stop.signal, onTurn }, async client => {
        const sink: DownloadSink = { destination: writableStream, bytesWritten: 0 };
        try {
          // When the signal closes the client, the RETR fails, and the raw RETR closes its data connection
          await this.downloadOverPassiveSocket(client, { filePath: remotePath, sink, signal: stop.signal });
        } catch (err) {
          // The user already has part of the file. A second download would add to that part, so the download fails.
          if (stop.signal.aborted || sink.bytesWritten > 0 || err instanceof NoFallbackError) throw err;
          const destination = limitBytes(writableStream, maxBytes);
          await this.downloadWithBasicFtp(client, { remotePath, destination, rawError: err });
        }
      });
    } catch (err) {
      rethrowIfBusy(err);
      throw new Error(`FTP download error: ${errorText(stop.reasonOr(err))}`, { cause: err });
    } finally {
      stop.end();
    }
  }

  /**
   * Upload one file. The upload stops at UPLOAD_TIME_LIMIT_MS, which starts when the upload gets its turn.
   * `signal` stops the upload, and takes a waiting upload out of the queue, for example when the browser leaves.
   */
  async uploadFile(
    remotePath: string,
    source: Buffer | string | NodeJS.ReadableStream,
    allowOverwrite = false,
    signal?: AbortSignal
  ): Promise<void> {
    const relativePath = toRelativeRemotePath(remotePath);
    const content = await toBuffer(source);
    const stop = new TaskStop(signal);

    try {
      assertSafeFtpArgument(relativePath);
      await this.withUploadConnection(stop, async client => {
        if (!allowOverwrite && await this.fileExists(client, relativePath)) {
          throw new Error(alreadyExistsMessage(relativePath));
        }
        await trySetBinaryMode(client);
        await client.uploadFrom(Readable.from(content), relativePath);
      });
    } catch (err) {
      rethrowIfBusy(err);
      if (!stop.signal.aborted && err instanceof Error && err.message.includes(ALREADY_EXISTS_MARKER)) {
        throw err;
      }
      throw new Error(`FTP upload error: ${errorText(stop.reasonOr(err))}`, { cause: err });
    } finally {
      stop.end();
    }
  }

  /**
   * Upload several files over one connection. Each file passes or fails on its own. The time limit and `signal` are
   * for the whole batch, as for uploadFile. After a stop, each file that is not on the machine fails with the reason.
   */
  async uploadFiles(files: FTPUploadFile[], allowOverwrite = false, signal?: AbortSignal): Promise<FTPUploadResult> {
    const results: FTPUploadResult = { success: [], failed: [] };
    const stop = new TaskStop(signal);

    try {
      await this.withUploadConnection(stop, async client => {
        await trySetBinaryMode(client);
        for (const file of files) {
          const outcome = await this.uploadBatchFile(client, { file, allowOverwrite, stop });
          if ('error' in outcome) results.failed.push(outcome);
          else results.success.push(outcome);
        }
      });
    } catch (err) {
      rethrowIfBusy(err);
      throw new Error(`FTP connection error: ${errorText(stop.reasonOr(err))}`, { cause: err });
    } finally {
      stop.end();
    }

    return results;
  }

  /** `signal` takes a waiting delete out of the queue, for example when the browser leaves */
  async deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    const relativePath = toRelativeRemotePath(remotePath);
    try {
      assertSafeFtpArgument(relativePath);
      await this.withConnection({ verbose: true, signal }, client => client.remove(relativePath));
    } catch (err) {
      rethrowIfBusy(err);
      throw new Error(`FTP delete error: ${errorText(err)}`, { cause: err });
    }
  }

  /**
   * The fallback: basic-ftp's standard download. A failed raw RETR closes the client, so log in again first.
   * When that second login fails, the error of the raw RETR tells the user more than the login error.
   */
  private async downloadWithBasicFtp(
    client: ftp.Client,
    { remotePath, destination, rawError }: { remotePath: string; destination: Writable; rawError: unknown }
  ): Promise<void> {
    if (client.closed) {
      try {
        await this.login(client);
      } catch {
        throw rawError;
      }
    }
    await client.downloadTo(destination, remotePath);
  }

  /**
   * Wait for the turn of this task, then open a connection, run `work` on it, and always close it. The next task gets
   * its turn only after the close. A new login inside `work` (on the same client) stays in this turn.
   * `signal` stops the wait for the turn, or closes the connection early, and then `work` fails.
   * `onTurn` runs when the task gets its turn, before the connection opens. The queue removes the abort listener of
   * `signal` and starts the task in one step, so the signal cannot abort between the two.
   */
  private withConnection<T>(
    options: { verbose: boolean; signal?: AbortSignal; onTurn?: () => void },
    work: (client: ftp.Client) => Promise<T>
  ): Promise<T> {
    return this.sessions.run(() => {
      options.onTurn?.();
      return this.runConnected(options, work);
    }, options.signal);
  }

  /** withConnection for an upload: `stop` has the signal of the caller, and gets the upload time limit at the turn */
  private withUploadConnection<T>(stop: TaskStop, work: (client: ftp.Client) => Promise<T>): Promise<T> {
    const { uploadTimeLimitMs } = this.downloadLimits;
    const onTurn = () => stop.startTimeLimit(uploadTimeLimitMs, () => uploadTooSlowError(uploadTimeLimitMs));
    return this.withConnection({ verbose: true, signal: stop.signal, onTurn }, work);
  }

  private async runConnected<T>(
    { verbose, signal }: { verbose: boolean; signal?: AbortSignal },
    work: (client: ftp.Client) => Promise<T>
  ): Promise<T> {
    const client = new ftp.Client(this.timeoutMs, { allowSeparateTransferHost: false, maxListingBytes: MAX_FOLDER_LIST_BYTES });
    useMachineHostForTransfers(client);
    client.ftp.verbose = verbose;
    const close = () => client.close();
    onAbort(signal, close);
    try {
      await this.login(client);
      return await work(client);
    } finally {
      signal?.removeEventListener('abort', close);
      client.close();
    }
  }

  private async login(client: ftp.Client): Promise<void> {
    await client.access({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      secure: false
    });
  }

  /**
   * Upload one file of an uploadFiles batch. A failure is returned, not thrown, so the batch goes on.
   * After a stop of the batch, the file fails with the reason of the stop.
   */
  private async uploadBatchFile(
    client: ftp.Client,
    { file, allowOverwrite, stop }: { file: FTPUploadFile; allowOverwrite: boolean; stop: TaskStop }
  ): Promise<BatchFileOutcome> {
    const remotePath = toRelativeRemotePath(file.remotePath);
    try {
      stop.signal.throwIfAborted();
      assertSafeFtpArgument(remotePath);
      if (!allowOverwrite && await this.fileExists(client, remotePath)) {
        return { remotePath, error: alreadyExistsMessage(remotePath) };
      }
      await client.uploadFrom(Readable.from(await toBuffer(file.source)), remotePath);
      return { remotePath };
    } catch (err) {
      return { remotePath, error: errorText(stop.reasonOr(err)) };
    }
  }

  private async fileExists(client: ftp.Client, filePath: string): Promise<boolean> {
    const { dirPath, fileName } = parseFilePath(filePath);
    try {
      const list = await listFolderWithLimits(client, dirPath);
      return list.some(item => item.name === fileName);
    } catch (err) {
      // A list that was too long or too slow does not tell if the file is there. The upload must not write over it.
      if (err instanceof FolderListLimitError) throw err;
      // The folder cannot be listed (for example it does not exist yet), so the file is not there
      return false;
    }
  }

  /**
   * Download with raw FTP commands over our own data socket: open the data
   * connection first, then send RETR. More compatible with limited FTP servers like Speedio.
   * When the download fails after the RETR, or the machine sends no reply to RETR, the client closes: a late 226 or
   * 426 must not go to the next command.
   * When no reply to RETR comes, the size from SIZE decides: the file is cut short when fewer bytes came. More bytes
   * than the size are accepted with a warning, because a control can convert a program on the transfer.
   * A machine that gives no size keeps the old behavior: Chatter accepts the file and logs a warning.
   */
  private async downloadOverPassiveSocket(
    client: ftp.Client,
    { filePath, sink, signal }: { filePath: string; sink: DownloadSink; signal: AbortSignal }
  ): Promise<void> {
    // basic-ftp refuses only CR, LF and NUL in a command, so this check is stricter
    assertSafeFtpArgument(filePath);
    await trySetBinaryMode(client);
    const expectedSize = await this.sizeOf(client, { filePath, signal });
    const { host, port } = await requestPassiveAddress(client.ftp);
    const dataSocket = await openDataSocket({ host, port, timeoutMs: this.rawDataConnectTimeoutMs() });
    let isConfirmed: boolean;
    try {
      isConfirmed = await this.receiveFile(client, { filePath, dataSocket, sink });
    } catch (err) {
      dataSocket.destroy();
      client.close();
      throw err;
    }
    if (isConfirmed) return;
    // A late reply must not go to the next command
    client.close();
    const context = { host: this.host, file: filePath, bytes: sink.bytesWritten };
    if (expectedSize === undefined) {
      log.warn('The machine did not confirm the end of the file (no reply to RETR), and gave no size. Chatter accepts the file, because the data connection ended correctly.', context);
    } else if (sink.bytesWritten < expectedSize) {
      log.warn('The machine did not confirm the end of the file (no reply to RETR), and sent fewer bytes than SIZE gave.', { ...context, size: expectedSize });
      throw new Error(`The file is not complete. The machine sent ${sink.bytesWritten} of ${expectedSize} bytes. Try again.`);
    } else if (sink.bytesWritten > expectedSize) {
      log.warn('The machine did not confirm the end of the file (no reply to RETR), and sent more bytes than SIZE gave. Chatter accepts the file, because the data connection ended correctly.', { ...context, size: expectedSize });
    }
  }

  /**
   * The size of a file in bytes from SIZE, or undefined when the machine does not give a clear size.
   * basic-ftp sets binary mode (TYPE I) at login, so the size is the byte count of a transfer.
   * When no reply comes in SIZE_REPLY_WAIT_MS, or the machine closes the connection, the size is unknown. A late reply
   * must not go to the next command, so the client logs in again on a new connection. A stop of the download
   * (by the user or by the time limit) stops it here, with no new login.
   */
  private async sizeOf(
    client: ftp.Client,
    { filePath, signal }: { filePath: string; signal: AbortSignal }
  ): Promise<number | undefined> {
    const timer = setTimeout(() => client.close(), Math.min(this.timeoutMs, SIZE_REPLY_WAIT_MS));
    try {
      const reply = await client.send(`SIZE ${filePath}`);
      const match = SIZE_REPLY_PATTERN.exec(reply.message);
      return match ? Number(match[1]) : undefined;
    } catch (err) {
      if (err instanceof ftp.FTPError) return undefined;
      signal.throwIfAborted();
      log.warn('The machine gave no reply to SIZE. Chatter connects again, and downloads the file with no size.', {
        host: this.host, file: filePath, error: errorText(err)
      });
      client.close();
      await this.login(client);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send RETR and write the data to the sink. The download is complete when the data connection ends cleanly
   * and the machine sends its 226 (or another 2xx) reply. An error reply (for example 426) fails the download.
   * When no reply comes in REPLY_AFTER_DATA_WAIT_MS after a clean end, the download is also complete, and the
   * promise gives false: some old FTP servers send no 226. A data connection that breaks fails the download.
   * The timer stops a download when no data comes in the FTP timeout. Each chunk starts it again.
   */
  private receiveFile(
    client: ftp.Client,
    { filePath, dataSocket, sink }: { filePath: string; dataSocket: net.Socket; sink: DownloadSink }
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let hasDataEnded = false;
      let isReplyDone = false;
      let isSettled = false;
      let timer: NodeJS.Timeout | undefined;

      /** An error fails the download. Else `isConfirmed` tells if the machine sent its reply. */
      const settle = (outcome: Error | { isConfirmed: boolean }) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome.isConfirmed);
      };
      const startTimer = (waitMs: number, onTimeUp: () => void) => {
        clearTimeout(timer);
        // A late chunk or end event after the end must not start a timer that nothing stops
        if (isSettled) return;
        timer = setTimeout(onTimeUp, waitMs);
      };
      const startIdleTimer = () => startTimer(this.timeoutMs, () => settle(new Error(DOWNLOAD_STALLED_MESSAGE)));
      const settleWhenComplete = () => {
        if (hasDataEnded && isReplyDone) settle({ isConfirmed: true });
      };
      /**
       * The destination is full, so the reader is slow, not the machine. Stop to read from the machine, so the file
       * does not wait in memory, and stop the idle timer until the destination takes more. The time limit still runs.
       */
      const waitForDrain = () => {
        dataSocket.pause();
        clearTimeout(timer);
        sink.destination.once('drain', () => {
          if (isSettled) return;
          dataSocket.resume();
          startIdleTimer();
        });
      };

      dataSocket.on('data', (chunk: Buffer) => {
        if (isSettled) return;
        if (sink.bytesWritten + chunk.length > this.downloadLimits.maxBytes) {
          settle(downloadTooLargeError(this.downloadLimits.maxBytes));
          return;
        }
        startIdleTimer();
        sink.bytesWritten += chunk.length;
        if (!sink.destination.write(chunk)) waitForDrain();
      });
      // 'end' comes only when the machine closes the data connection cleanly, not when the connection breaks
      dataSocket.on('end', () => {
        hasDataEnded = true;
        // The wait starts again here, so a slow last chunk leaves the full wait for the reply
        startTimer(Math.min(this.timeoutMs, REPLY_AFTER_DATA_WAIT_MS), () => settle({ isConfirmed: false }));
        settleWhenComplete();
      });
      dataSocket.on('error', err => settle(err));

      startIdleTimer();
      client.ftp.handle(`RETR ${filePath}`, (reply, task) => {
        if (reply instanceof ftp.FTPError && reply.code !== CANNOT_OPEN_DATA_CONNECTION) {
          task.reject(new NoFallbackError(reply.message, { cause: reply }));
        } else if (reply instanceof Error) task.reject(reply);
        else if (reply.code >= 200 && reply.code < 300) task.resolve(reply);
        else if (reply.code >= 300) task.reject(new Error(`Unexpected reply to RETR: ${reply.message}`));
        // A 1xx reply (for example 150) only tells that the transfer starts
      }).then(() => {
        isReplyDone = true;
        settleWhenComplete();
      }, (err: Error) => settle(err));
      // The timers above watch the transfer. The control connection is quiet until the 226, so its own timeout stops.
      client.ftp.socket.setTimeout(0);
    });
  }

  /**
   * Send a bare LIST over our own data socket and return the raw listing.
   * basic-ftp sends "LIST -a", which some limited FTP servers do not support.
   * The listing stops at MAX_FOLDER_LIST_BYTES: then the data socket is destroyed, and the listing has the complete lines.
   */
  private async rawListCurrentDirectory(client: ftp.Client): Promise<RawListing> {
    const { host, port } = await requestPassiveAddress(client.ftp);
    const dataSocket = await openDataSocket({ host, port, timeoutMs: this.rawDataConnectTimeoutMs() });
    return this.receiveListing(client, dataSocket);
  }

  /**
   * Send LIST and read the listing, as receiveFile reads a file. The listing is complete when the data connection
   * ends cleanly and the machine sends its 2xx reply. Then it resolves at once.
   * - An error reply (for example 426) or a stall after some bytes cuts the listing short. An error with no byte
   *   rejects, so the fallback can try. After an error reply, the client still reads the data until it ends, for
   *   REPLY_AFTER_LIST_WAIT_MS at most, because the data can come after the reply.
   * - Some old servers send no reply. After the first byte, a listing with no reply is complete when its data
   *   ends cleanly or when no data comes, each for REPLY_AFTER_LIST_WAIT_MS. It keeps all its text, also a last line
   *   with no line end, and is not cut short (as before the reply check). New data starts the wait again. So a pause
   *   of that length in the middle of the data also ends the listing, with no error.
   * - Some servers do not close the data connection. A listing with a 2xx reply is then complete when no data
   *   comes in REPLY_AFTER_LIST_WAIT_MS. A pause of that length in the middle of the data also ends it. When the
   *   pause cuts a line, the listing is cut short.
   * - Before the first byte, the wait for data is the FTP timeout. With no byte, the fallback can try.
   * A listing whose data broke, or that got an error reply, keeps only its complete lines, and is cut short when it
   * lost a line. When the reply did not come, the client closes, so a late reply cannot go to the next command. The
   * walk then logs in again only when it opens another folder.
   */
  private receiveListing(client: ftp.Client, dataSocket: net.Socket): Promise<RawListing> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let byteCount = 0;
      let isTooLong = false;
      let hasDataEnded = false;
      let isReplyDone = false;
      /** The error reply to LIST. The client reads the rest of the data first, as it can come after the reply. */
      let replyError: Error | undefined;
      let isSettled = false;
      let timer: NodeJS.Timeout | undefined;

      const listing = (isCut: boolean): RawListing => {
        const text = Buffer.concat(chunks).toString();
        // With no reply, a clean end of the data or a wait with no data ends the listing: some old servers send no
        // reply, and some do not close the data connection. Before the reply check, such a listing was complete.
        const isWhole = !isCut && !replyError && !isTooLong && (hasDataEnded || !isReplyDone);
        if (isWhole) return { text, isTooLong, isCut: false };
        const lines = completeLines(text);
        return { text: lines, isTooLong, isCut: isCut || lines.length < text.length };
      };
      const settle = (outcome: Error | { isCut: boolean }) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        dataSocket.destroy();
        if (!isReplyDone) client.close();
        if (outcome instanceof Error) reject(outcome);
        else resolve(listing(outcome.isCut));
      };
      // The bytes that came are kept. With no byte, the fallback can still read the listing.
      const fail = (err: Error) => settle(byteCount > 0 ? { isCut: true } : err);
      const startTimer = (waitMs: number, onTimeUp: () => void) => {
        clearTimeout(timer);
        if (!isSettled) timer = setTimeout(onTimeUp, waitMs);
      };
      const startIdleTimer = () => startTimer(this.timeoutMs, () => fail(new Error('Timeout: the raw LIST data connection is idle')));
      const finish = () => (replyError ? fail(replyError) : settle({ isCut: false }));
      const startReplyWait = () => startTimer(Math.min(this.timeoutMs, REPLY_AFTER_LIST_WAIT_MS), finish);
      const settleWhenComplete = () => {
        if (hasDataEnded && isReplyDone) finish();
        else startReplyWait();
      };

      dataSocket.on('data', (chunk: Buffer) => {
        if (isSettled) return;
        const room = MAX_FOLDER_LIST_BYTES - byteCount;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        byteCount += Math.min(chunk.length, room);
        if (chunk.length > room) {
          isTooLong = true;
          settle({ isCut: false });
        } else startReplyWait();
      });
      // 'end' comes only when the machine closes the data connection cleanly, not when the connection breaks
      dataSocket.on('end', () => {
        hasDataEnded = true;
        settleWhenComplete();
      });
      dataSocket.on('error', fail);

      startIdleTimer();
      client.ftp.handle('LIST', (reply, task) => {
        if (reply instanceof Error) task.reject(reply);
        else if (reply.code >= 200 && reply.code < 300) task.resolve(reply);
        else if (reply.code >= 300) task.reject(new Error(`Unexpected reply to LIST: ${reply.message}`));
        // A 1xx reply (for example 150) only tells that the transfer starts
      }).then(() => {
        isReplyDone = true;
        settleWhenComplete();
      }, (err: Error) => {
        // The machine answered. A closed control connection is closed anyway.
        isReplyDone = true;
        replyError = err;
        settleWhenComplete();
      });
      // The timers above watch the transfer. The control connection is quiet until the 226, so its own timeout stops.
      client.ftp.socket.setTimeout(0);
    });
  }

  private treeCutMessage(reason: TreeCutReason): string {
    switch (reason) {
      case 'entries':
        return `The file tree on ${this.host} is too large. Chatter shows only the first ${MAX_TREE_ENTRIES} entries.`;
      case 'folders':
        return `The file tree on ${this.host} has too many folders. Chatter opens at most ${MAX_TREE_FOLDERS} folders.`;
      case 'time':
        return `The file tree on ${this.host} took too long. Chatter stops a walk after ${TREE_WALK_TIME_LIMIT_MS / 1000} s.`;
      case 'longList':
        return `A folder list on ${this.host} is too long. Chatter reads at most ${MAX_FOLDER_LIST_MB} MB of one folder list, and then opens no more folders.`;
      case 'cutList':
        return `A folder list on ${this.host} ended before it was complete. Chatter shows the complete lines that it read.`;
      case 'login':
        return `The connection to ${this.host} closed during the file tree, and Chatter could not log in again. Chatter shows the part that it read.`;
    }
  }

  /** The connect timeout of the raw data connections. It is never longer than the FTP timeout. */
  private rawDataConnectTimeoutMs(): number {
    return Math.min(this.timeoutMs, RAW_DATA_CONNECT_TIMEOUT_MS);
  }

  /**
   * List the folder `path`, which is the current folder: bare LIST first, then basic-ftp's list. An empty list when
   * both fail. A raw listing that is too long keeps its first lines, and the fallback does not run.
   * basic-ftp keeps nothing of a listing that is too long.
   * A raw LIST that got no reply closed the client. The fallback then logs in again, and opens `path` again, because
   * a new session starts in the login folder.
   */
  private async listCurrentDirectory(
    client: ftp.Client,
    { path, walk }: { path: string; walk: TreeWalk }
  ): Promise<FolderListing> {
    let raw: RawListing;
    try {
      raw = await this.rawListCurrentDirectory(client);
    } catch {
      if (client.closed) {
        if (!(await this.loginAgainForWalk(client, walk))) return emptyListing();
        await openFolder(client, path);
      }
      return listWithBasicFtp(client);
    }
    return { entries: parseRawList(raw.text), isTooLong: raw.isTooLong, isCut: raw.isCut };
  }

  /**
   * Log in again when the client closed, for example after a raw LIST that got no reply. False when the walk must
   * stop: after its time limit (which closed the client), or when the new login fails. The walk then keeps what it read.
   * It does not use stopReasonOf, because the folder limit is reached while the last folder is still in the list.
   */
  private async loginAgainForWalk(client: ftp.Client, walk: TreeWalk): Promise<boolean> {
    if (!client.closed) return true;
    if (walk.stopReason) return false;
    try {
      await this.login(client);
      return true;
    } catch (err) {
      stopWalk(walk, 'login');
      log.debug('The new login of the file tree walk failed', { host: this.host, error: errorText(err) });
      return false;
    }
  }

  /**
   * Build the tree below `path`, `depth` levels deep, one level at a time.
   * The walk lists all the folders of one level before it opens the level below it,
   * so the entry limit cuts the deepest level first and the upper levels stay complete.
   * A folder that cannot be opened gives an empty list, so one bad folder does not hide the rest of the tree.
   * The walk opens no more folders when it has no entries or folders left, after its time limit,
   * or after a folder listing that is too long.
   * Each folder that it did not open has no children.
   */
  private async buildTree(
    client: ftp.Client,
    { path, depth, walk }: { path: string; depth: number; walk: TreeWalk }
  ): Promise<FTPTreeNode[]> {
    const top: TreeFolder = { path, nodes: [] };
    let level: TreeFolder[] = [top];
    for (let levelsLeft = depth; levelsLeft > 0 && level.length > 0; levelsLeft--) {
      const nextLevel: TreeFolder[] = [];
      for (const folder of level) {
        const stopReason = stopReasonOf(walk);
        if (stopReason) {
          cutWalk(walk, stopReason);
          return top.nodes;
        }
        walk.foldersLeft -= 1;
        const { entries, isTooLong, isCut } = await this.listFolder(client, { path: folder.path, walk });
        if (isTooLong) stopWalk(walk, 'longList');
        if (isCut) cutWalk(walk, 'cutList');
        const kept = entries.slice(0, walk.entriesLeft);
        walk.entriesLeft -= kept.length;
        if (kept.length < entries.length) cutWalk(walk, 'entries');
        for (const entry of kept) {
          const node = treeNodeOf(entry, folder.path);
          folder.nodes.push(node);
          if (entry.isDir && levelsLeft > 1) {
            node.children = [];
            nextLevel.push({ path: node.path, nodes: node.children });
          }
        }
      }
      level = nextLevel;
    }
    return top.nodes;
  }

  /**
   * The entries of one folder. A folder that cannot be opened gives an empty list.
   * When the client closed, for example after a listing that got no reply, it logs in again first.
   * When that login fails, or the time limit came, the walk stops and keeps what it read.
   */
  private async listFolder(client: ftp.Client, { path, walk }: { path: string; walk: TreeWalk }): Promise<FolderListing> {
    try {
      if (!(await this.loginAgainForWalk(client, walk))) return emptyListing();
      await openFolder(client, path);
      return await this.listCurrentDirectory(client, { path, walk });
    } catch {
      return emptyListing();
    }
  }
}

/** Make `path` the current folder, as the walk always did: CWD, then PWD */
async function openFolder(client: ftp.Client, path: string): Promise<void> {
  await client.cd(path);
  await client.pwd();
}

function emptyListing(): FolderListing {
  return { entries: [], isTooLong: false, isCut: false };
}

function treeNodeOf(entry: RawListEntry, parentPath: string): FTPTreeNode {
  return {
    name: entry.name,
    type: entry.isDir ? 'directory' : 'file',
    size: entry.size || 0,
    path: joinRemotePath(parentPath, entry.name)
  };
}

/** The fallback list of the tree walk. The time limit of the walk also stops it. */
async function listWithBasicFtp(client: ftp.Client): Promise<FolderListing> {
  try {
    const list = await client.list();
    return { entries: list.map(item => ({ name: item.name, isDir: item.isDirectory, size: item.size })), isTooLong: false, isCut: false };
  } catch (err) {
    return { ...emptyListing(), isTooLong: isListingTooLong(err) };
  }
}
