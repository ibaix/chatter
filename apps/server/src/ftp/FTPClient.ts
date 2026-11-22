import net from 'net';
import { Readable, Writable } from 'stream';
import * as ftp from 'basic-ftp';
import { ftpErrorMessage } from './ftpErrorMessage.js';
import { FILE_TREE_ENTRY_LIMIT } from '@local-chatter/shared';
import { createLogger } from '../logging/logger.js';
import type { FileTree, FTPConfig, FTPFileInfo, FTPTreeNode, FTPUploadFile, FTPUploadResult } from '../types/index.js';

const DEFAULT_FTP_PORT = 21;
const DEFAULT_FTP_USER = 'anonymous';
/** The time that the FTP client waits for the machine. This is also the default of basic-ftp. */
const DEFAULT_FTP_TIMEOUT_MS = 30_000;
const DEFAULT_TREE_DEPTH = 2;
/**
 * The most folder levels that one tree request walks. Each level costs a LIST on the machine.
 * The web app asks for 3 levels, and CNC program folders are not deeper than this.
 */
export const MAX_TREE_DEPTH = 5;
/** The most entries (files and folders) in one tree, so a very large or rogue FTP server cannot fill the memory */
export const MAX_TREE_ENTRIES = FILE_TREE_ENTRY_LIMIT;
const ROOT_PATH = '/';

/** The manual download gives up when no byte arrives in this time */
const DOWNLOAD_NO_DATA_TIMEOUT_MS = 30_000;
/** The raw LIST does not wait for the server to close the data connection, so it waits this long for the listing */
const RAW_LIST_TRANSFER_WAIT_MS = 1_000;
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
  /** True when the walk left out an entry or a folder */
  isCut: boolean;
}

type BatchFileOutcome = FTPUploadResult['success'][number] | FTPUploadResult['failed'][number];

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

function alreadyExistsMessage(remotePath: string): string {
  return `File "${remotePath}" ${ALREADY_EXISTS_MARKER}. Enable overwrite to replace it.`;
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

/**
 * Reusable FTP client for CNC machine file operations.
 * Handles file listing, tree browsing, downloads, uploads, and deletes.
 * Compatible with limited FTP servers (like Speedio) via manual PASV mode.
 */
export class FTPClient {
  private host: string;
  private port: number;
  private user: string;
  private password: string;
  private readonly timeoutMs: number;

  constructor({
    host, port = DEFAULT_FTP_PORT, user = DEFAULT_FTP_USER, password = '', timeoutMs = DEFAULT_FTP_TIMEOUT_MS
  }: FTPConfig) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  /** Change connection settings (for example after a machine config change) */
  updateConfig({ host, port, user, password }: Partial<FTPConfig>): void {
    if (host !== undefined) this.host = host;
    if (port !== undefined) this.port = port;
    if (user !== undefined) this.user = user;
    if (password !== undefined) this.password = password;
  }

  async listFiles(path = ROOT_PATH): Promise<FTPFileInfo[]> {
    try {
      assertSafeFtpArgument(path);
      const list = await this.withConnection({ verbose: false }, client => client.list(path));
      return list.map(item => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        modifiedAt: item.modifiedAt,
        path: joinRemotePath(path, item.name)
      }));
    } catch (err) {
      throw new Error(ftpErrorMessage(err, this.host, this.port), { cause: err });
    }
  }

  async getFileTree(path = ROOT_PATH, depth = DEFAULT_TREE_DEPTH): Promise<FTPTreeNode[]> {
    return (await this.readFileTree(path, depth)).nodes;
  }

  /** The file tree, and whether the walk cut it at MAX_TREE_ENTRIES entries. The depth limit does not count as a cut. */
  async readFileTree(path = ROOT_PATH, depth = DEFAULT_TREE_DEPTH): Promise<FileTree> {
    const walk: TreeWalk = { entriesLeft: MAX_TREE_ENTRIES, isCut: false };
    try {
      assertSafeFtpArgument(path);
      if (depth <= 0) {
        return { nodes: [], isCutShort: false };
      }
      const nodes = await this.withConnection({ verbose: false }, client => this.buildTree(client, { path, depth: Math.min(depth, MAX_TREE_DEPTH), walk }));
      if (walk.isCut) {
        log.warn(`The file tree on ${this.host} is too large. Chatter shows only the first ${MAX_TREE_ENTRIES} entries.`, { path });
      }
      return { nodes, isCutShort: walk.isCut };
    } catch (err) {
      throw new Error(ftpErrorMessage(err, this.host, this.port), { cause: err });
    }
  }

  async downloadFile(filePath: string, writableStream: Writable): Promise<void> {
    const remotePath = toRelativeRemotePath(filePath);
    try {
      assertSafeFtpArgument(remotePath);
      await this.withConnection({ verbose: true }, async client => {
        try {
          await this.downloadOverPassiveSocket(client, remotePath, writableStream);
        } catch {
          // Fall back to basic-ftp's standard download
          await client.downloadTo(writableStream, remotePath);
        }
      });
    } catch (err) {
      throw new Error(`FTP download error: ${errorText(err)}`, { cause: err });
    }
  }

  async uploadFile(
    remotePath: string,
    source: Buffer | string | NodeJS.ReadableStream,
    allowOverwrite = false
  ): Promise<void> {
    const relativePath = toRelativeRemotePath(remotePath);
    const content = await toBuffer(source);

    try {
      assertSafeFtpArgument(relativePath);
      await this.withConnection({ verbose: true }, async client => {
        if (!allowOverwrite && await this.fileExists(client, relativePath)) {
          throw new Error(alreadyExistsMessage(relativePath));
        }
        await trySetBinaryMode(client);
        await client.uploadFrom(Readable.from(content), relativePath);
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes(ALREADY_EXISTS_MARKER)) {
        throw err;
      }
      throw new Error(`FTP upload error: ${errorText(err)}`, { cause: err });
    }
  }

  /** Upload several files over one connection. Each file passes or fails on its own. */
  async uploadFiles(files: FTPUploadFile[], allowOverwrite = false): Promise<FTPUploadResult> {
    const results: FTPUploadResult = { success: [], failed: [] };

    try {
      await this.withConnection({ verbose: true }, async client => {
        await trySetBinaryMode(client);
        for (const file of files) {
          const outcome = await this.uploadBatchFile(client, { file, allowOverwrite });
          if ('error' in outcome) results.failed.push(outcome);
          else results.success.push(outcome);
        }
      });
    } catch (err) {
      throw new Error(`FTP connection error: ${errorText(err)}`, { cause: err });
    }

    return results;
  }

  async deleteFile(remotePath: string): Promise<void> {
    const relativePath = toRelativeRemotePath(remotePath);
    try {
      assertSafeFtpArgument(relativePath);
      await this.withConnection({ verbose: true }, client => client.remove(relativePath));
    } catch (err) {
      throw new Error(`FTP delete error: ${errorText(err)}`, { cause: err });
    }
  }

  /** Open a connection, run `work` on it, and always close it */
  private async withConnection<T>(
    { verbose }: { verbose: boolean },
    work: (client: ftp.Client) => Promise<T>
  ): Promise<T> {
    const client = new ftp.Client(this.timeoutMs);
    useMachineHostForTransfers(client);
    client.ftp.verbose = verbose;
    try {
      await client.access({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
        secure: false
      });
      return await work(client);
    } finally {
      client.close();
    }
  }

  /** Upload one file of an uploadFiles batch. A failure is returned, not thrown, so the batch goes on. */
  private async uploadBatchFile(
    client: ftp.Client,
    { file, allowOverwrite }: { file: FTPUploadFile; allowOverwrite: boolean }
  ): Promise<BatchFileOutcome> {
    const remotePath = toRelativeRemotePath(file.remotePath);
    try {
      assertSafeFtpArgument(remotePath);
      if (!allowOverwrite && await this.fileExists(client, remotePath)) {
        return { remotePath, error: alreadyExistsMessage(remotePath) };
      }
      await client.uploadFrom(Readable.from(await toBuffer(file.source)), remotePath);
      return { remotePath };
    } catch (err) {
      return { remotePath, error: errorText(err) };
    }
  }

  private async fileExists(client: ftp.Client, filePath: string): Promise<boolean> {
    const { dirPath, fileName } = parseFilePath(filePath);
    try {
      const list = await client.list(dirPath);
      return list.some(item => item.name === fileName);
    } catch {
      // The folder cannot be listed (for example it does not exist yet), so the file is not there
      return false;
    }
  }

  /**
   * Download with raw FTP commands over our own data socket: open the data
   * connection first, then send RETR. More compatible with limited FTP servers like Speedio.
   */
  private async downloadOverPassiveSocket(client: ftp.Client, filePath: string, destination: Writable): Promise<void> {
    // The RETR below goes straight to the socket, so basic-ftp does not check it
    assertSafeFtpArgument(filePath);
    await trySetBinaryMode(client);
    const { host, port } = await requestPassiveAddress(client.ftp);
    const dataSocket = await openDataSocket({ host, port, timeoutMs: this.rawDataConnectTimeoutMs() });

    return new Promise((resolve, reject) => {
      // Stops a download that gets no data. The first byte, an error or the close stops this timer.
      const noDataTimer = setTimeout(() => {
        dataSocket.destroy();
        reject(new Error('Download timeout'));
      }, DOWNLOAD_NO_DATA_TIMEOUT_MS);

      dataSocket.on('data', chunk => {
        clearTimeout(noDataTimer);
        destination.write(chunk);
      });
      dataSocket.on('close', () => {
        clearTimeout(noDataTimer);
        resolve();
      });
      dataSocket.on('error', err => {
        clearTimeout(noDataTimer);
        reject(err);
      });

      // Written straight to the control socket without waiting for the reply, so data can flow on the data socket
      client.ftp.socket.write(`RETR ${filePath}\r\n`);
    });
  }

  /**
   * Send a bare LIST over our own data socket and return the raw listing.
   * basic-ftp sends "LIST -a", which some limited FTP servers do not support.
   */
  private async rawListCurrentDirectory(client: ftp.Client): Promise<string> {
    const { host, port } = await requestPassiveAddress(client.ftp);
    const dataSocket = await openDataSocket({ host, port, timeoutMs: this.rawDataConnectTimeoutMs() });

    return new Promise((resolve, reject) => {
      let listing = '';

      dataSocket.on('data', chunk => {
        listing += chunk.toString();
      });
      dataSocket.on('error', reject);
      // Until the reply to LIST comes, an idle data connection is destroyed, so the walk goes on with the fallback.
      // After the reply, the wait for the listing has its own short limit, and a folder can be empty.
      dataSocket.setTimeout(this.timeoutMs, () => {
        dataSocket.destroy();
        reject(new Error('Timeout: the raw LIST data connection is idle'));
      });

      client.send('LIST').then(() => {
        dataSocket.setTimeout(0);
        setTimeout(() => {
          dataSocket.end();
          resolve(listing);
        }, RAW_LIST_TRANSFER_WAIT_MS);
      }, (err: unknown) => {
        dataSocket.end();
        reject(err);
      });
    });
  }

  /** The connect timeout of the raw data connections. It is never longer than the FTP timeout. */
  private rawDataConnectTimeoutMs(): number {
    return Math.min(this.timeoutMs, RAW_DATA_CONNECT_TIMEOUT_MS);
  }

  /** List the current folder: bare LIST first, then basic-ftp's list. An empty list when both fail. */
  private async listCurrentDirectory(client: ftp.Client): Promise<RawListEntry[]> {
    try {
      return parseRawList(await this.rawListCurrentDirectory(client));
    } catch {
      try {
        const list = await client.list();
        return list.map(item => ({ name: item.name, isDir: item.isDirectory, size: item.size }));
      } catch {
        return [];
      }
    }
  }

  /**
   * Build the tree below `path`, `depth` levels deep. A folder that cannot be
   * opened gives an empty list, so one bad folder does not hide the rest of the tree.
   * The walk stops when it has no entries left, and then it opens no more folders.
   */
  private async buildTree(
    client: ftp.Client,
    { path, depth, walk }: { path: string; depth: number; walk: TreeWalk }
  ): Promise<FTPTreeNode[]> {
    if (depth <= 0) {
      return [];
    }
    if (walk.entriesLeft <= 0) {
      walk.isCut = true;
      return [];
    }
    try {
      await client.cd(path);
      await client.pwd();
      const entries = await this.listCurrentDirectory(client);

      // Count the whole folder before a walk into its subfolders, so the upper levels stay complete
      const kept = entries.slice(0, walk.entriesLeft);
      walk.entriesLeft -= kept.length;
      if (kept.length < entries.length) walk.isCut = true;
      const nodes: FTPTreeNode[] = [];
      for (const entry of kept) {
        nodes.push(await this.treeNodeFor(client, { entry, parentPath: path, depth, walk }));
      }
      return nodes;
    } catch {
      return [];
    }
  }

  private async treeNodeFor(
    client: ftp.Client,
    { entry, parentPath, depth, walk }: { entry: RawListEntry; parentPath: string; depth: number; walk: TreeWalk }
  ): Promise<FTPTreeNode> {
    const fullPath = joinRemotePath(parentPath, entry.name);
    const node: FTPTreeNode = {
      name: entry.name,
      type: entry.isDir ? 'directory' : 'file',
      size: entry.size || 0,
      path: fullPath
    };
    if (entry.isDir && depth > 1) {
      node.children = await this.buildTree(client, { path: fullPath, depth: depth - 1, walk });
    }
    return node;
  }
}
