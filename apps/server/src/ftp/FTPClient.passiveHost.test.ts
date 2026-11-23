import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import { PassThrough, Writable } from 'stream';
import * as ftp from 'basic-ftp';
import {
  FTPClient, MAX_FOLDER_LIST_BYTES, REPLY_AFTER_DATA_WAIT_MS, SIZE_REPLY_WAIT_MS, TREE_WALK_TIME_LIMIT_MS, type DownloadLimits
} from './FTPClient.js';
import { captureLog } from '../logging/testSupport.js';
import type { FTPTreeNode } from '../types/index.js';

// A rogue machine can name any host in its PASV reply, so Chatter would open a connection to a host of its choice.
// The data connection must go only to the host of the control connection, and only the port comes from the reply.
//
// The fake machine listens on the IPv6 loopback (::1). Its PASV reply names 127.0.0.1, where a decoy listens on the
// same port. A connection to the decoy proves that the client used the host of the reply.
//
// basic-ftp accepts these two hosts as the same, because both are loopback addresses. For basic-ftp, a second fake
// machine listens on 127.0.0.1 and its PASV reply names 192.0.2.1 (TEST-NET-1), as a machine behind NAT can do.
// No computer answers at that address, so the tests record each connection that the client starts.

const CONTROL_HOST = '::1';
const PASV_REPLY_HOST = '127.0.0.1';
const NAT_CONTROL_HOST = '127.0.0.1';
const NAT_PASV_REPLY_HOST = '192.0.2.1';
const PROGRAM_TEXT = '%\nO1000\nG00 X0\nM30\n%\n';
const LISTING = '-rw-r--r-- 1 cnc cnc 20 Jan 01 12:00 O1000\r\n-rw-r--r-- 1 cnc cnc 30 Jan 01 12:00 O2000\r\n';

interface FakeMachine {
  controlPort: number;
  /** The port of the data listener at the control host */
  dataPort: number;
  /** Data connections that arrived at the control host */
  dataConnections: number;
  /** Data connections that arrived at the host of the PASV reply */
  decoyConnections: number;
  /** The text of the last STOR */
  uploadedText: string;
  /** The first word of each command that the machine got */
  commands: string[];
  /** Each command line that the machine got, with its argument */
  lines: string[];
  /** Control connections (logins) that the machine got */
  controlConnections: number;
  close(): Promise<void>;
}

/** One RETR or LIST on the fake machine, after its 150 reply */
interface FileTransfer {
  control: net.Socket;
  data: net.Socket;
  /** 1 for the first RETR (or LIST) of the machine, 2 for the next, and so on */
  retrNumber: number;
}

/** The usual RETR: send the whole file, close the data connection, then send 226 */
function sendWholeFile({ control, data }: FileTransfer, programText: string): void {
  data.end(programText, () => control.write('226 Transfer complete\r\n'));
}

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only: net.isIPv6(host) }, () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** Some computers and CI runners have no IPv6 loopback. Then the tests that need ::1 are skipped. */
async function canListenOn(host: string): Promise<boolean> {
  const server = net.createServer();
  try {
    await listen(server, 0, host);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

const hasIpv6Loopback = await canListenOn(CONTROL_HOST);

const SAME_PORT_TRIES = 10;

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

/**
 * Listen with `first` on a free port, then with `second` on the same port at another host.
 * Another program can use that port at the second host, so try again with a new port.
 */
async function listenOnSamePort(
  first: { server: net.Server; host: string },
  second: { server: net.Server; host: string }
): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await listen(first.server, 0, first.host);
    try {
      await listen(second.server, port, second.host);
      return port;
    } catch (err) {
      await closeServer(first.server);
      if (!isAddressInUse(err) || attempt >= SAME_PORT_TRIES) throw err;
    }
  }
}

function readAll(socket: net.Socket): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk));
  return new Promise(resolve => socket.on('end', () => resolve(Buffer.concat(chunks).toString())));
}

/** Reply to the commands of FTPClient and basic-ftp. RETR, LIST and STOR use the next data connection. */
function answerCommands(socket: net.Socket, {
  pasvReply, epsvReply, nextDataSocket, onUpload, commands, lines, sendFile, sendListing, passReply, replies, storReply
}: {
  pasvReply: () => string;
  /** The reply to PASS, or undefined for no reply */
  passReply: string | undefined;
  sendFile: (transfer: Omit<FileTransfer, 'retrNumber'>) => void;
  sendListing: (transfer: Omit<FileTransfer, 'retrNumber'>) => void;
  replies: Record<string, MachineReply>;
  storReply: string;
  epsvReply: string;
  nextDataSocket: () => Promise<net.Socket>;
  onUpload: (text: string) => void;
  commands: string[];
  lines: string[];
}): void {
  socket.write('220 Fake machine\r\n');
  let buffered = '';
  socket.on('data', async chunk => {
    buffered += chunk.toString();
    let lineEnd: number;
    while ((lineEnd = buffered.indexOf('\r\n')) >= 0) {
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 2);
      const command = line.split(' ')[0].toUpperCase();
      commands.push(command);
      lines.push(line);
      const reply = replies[command];
      if (typeof reply === 'function') reply(socket);
      else if (reply !== undefined) socket.write(`${reply}\r\n`);
      else if (command === 'USER') socket.write('331 Password\r\n');
      else if (command === 'PASS') {
        if (passReply !== undefined) socket.write(`${passReply}\r\n`);
      }
      else if (command === 'PASV') socket.write(`${pasvReply()}\r\n`);
      else if (command === 'EPSV') socket.write(`${epsvReply}\r\n`);
      else if (command === 'PWD') socket.write('257 "/"\r\n');
      else if (command === 'CWD') socket.write('250 OK\r\n');
      else if (command === 'RETR') {
        socket.write('150 Opening data connection\r\n');
        sendFile({ control: socket, data: await nextDataSocket() });
      } else if (command === 'LIST') {
        socket.write('150 Opening data connection\r\n');
        sendListing({ control: socket, data: await nextDataSocket() });
      } else if (command === 'STOR') {
        socket.write('150 Ready for data\r\n');
        onUpload(await readAll(await nextDataSocket()));
        socket.write(`${storReply}\r\n`);
      } else socket.write('200 OK\r\n');
    }
  });
  socket.on('error', () => undefined);
}

interface FakeMachineOptions {
  controlHost?: string;
  pasvReplyHost?: string;
  /** The machine answers EPSV. Without this, EPSV gets "500 Not supported". */
  supportsEpsv?: boolean;
  /** The PASV reply has no parentheses around the address and the port */
  bareAddress?: boolean;
  /** The text of the PASV reply, made from the port of the data listener. It replaces the usual reply. */
  pasvReplyFor?: (dataPort: number) => string;
  /** The machine refuses the first PASV, so the first data transfer fails */
  refuseFirstPasv?: boolean;
  /** The text of each file that RETR sends */
  programText?: string;
  /** What the machine does for a RETR after its 150 reply. The default is sendWholeFile with programText. */
  sendFile?: (transfer: FileTransfer) => void;
  /** The text that each LIST sends */
  listing?: string;
  /** What the machine does for a LIST after its 150 reply. The default is sendWholeFile with listing. */
  sendListing?: (transfer: FileTransfer) => void;
  /**
   * A fixed reply to a command, by its first word. For example { SIZE: '213 23' }. A function replaces the reply:
   * it can send nothing, or close the control connection.
   */
  replies?: Record<string, MachineReply>;
  /** The reply after the data of a STOR */
  storReply?: string;
  /** The machine refuses the login from this control connection on (1 for the first) */
  refuseLoginFrom?: number;
  /** The machine sends no reply to PASS from this control connection on (1 for the first) */
  holdLoginFrom?: number;
}

/** The reply text, or what the machine does in place of a reply */
type MachineReply = string | ((control: net.Socket) => void);

const MACHINE_DEFAULTS = {
  controlHost: CONTROL_HOST, pasvReplyHost: PASV_REPLY_HOST, supportsEpsv: false, bareAddress: false, refuseFirstPasv: false,
  programText: PROGRAM_TEXT, listing: LISTING, replies: {}, storReply: '226 Transfer complete'
};

/** A decoy listens at the host of the PASV reply only when that host is on this computer */
async function startFakeMachine(options: FakeMachineOptions = {}): Promise<FakeMachine> {
  const {
    controlHost, pasvReplyHost, supportsEpsv, bareAddress, pasvReplyFor, refuseFirstPasv, programText, listing, replies, storReply,
    refuseLoginFrom = Infinity, holdLoginFrom = Infinity, sendFile = (transfer: FileTransfer) => sendWholeFile(transfer, programText),
    sendListing = (transfer: FileTransfer) => sendWholeFile(transfer, listing)
  } = { ...MACHINE_DEFAULTS, ...options };
  const dataSockets: net.Socket[] = [];
  const dataWaiters: Array<(socket: net.Socket) => void> = [];
  const machine = {
    dataConnections: 0, decoyConnections: 0, controlConnections: 0, retrCount: 0, listCount: 0, uploadedText: '', commands: [] as string[], lines: [] as string[]
  };

  const openDataSockets = new Set<net.Socket>();
  const dataServer = net.createServer(socket => {
    machine.dataConnections += 1;
    openDataSockets.add(socket);
    socket.on('error', () => undefined);
    const waiter = dataWaiters.shift();
    if (waiter) waiter(socket);
    else dataSockets.push(socket);
  });
  const decoyServer = net.createServer(socket => {
    machine.decoyConnections += 1;
    socket.on('error', () => undefined);
    socket.end();
  });
  const dataPort = pasvReplyHost === PASV_REPLY_HOST
    ? await listenOnSamePort({ server: dataServer, host: controlHost }, { server: decoyServer, host: pasvReplyHost })
    : await listen(dataServer, 0, controlHost);

  const address = `${pasvReplyHost.replaceAll('.', ',')},${Math.floor(dataPort / 256)},${dataPort % 256}`;
  const pasvReply = pasvReplyFor?.(dataPort) ?? `227 Entering Passive Mode ${bareAddress ? address : `(${address})`}`;
  const epsvReply = supportsEpsv ? `229 Entering Extended Passive Mode (|||${dataPort}|)` : '500 Not supported';
  const nextDataSocket = () => new Promise<net.Socket>(resolve => {
    const socket = dataSockets.shift();
    if (socket) resolve(socket);
    else dataWaiters.push(resolve);
  });

  let pasvCount = 0;
  const nextPasvReply = () => {
    pasvCount += 1;
    return refuseFirstPasv && pasvCount === 1 ? '425 Cannot open data connection' : pasvReply;
  };

  const controlSockets = new Set<net.Socket>();
  const controlServer = net.createServer(socket => {
    controlSockets.add(socket);
    machine.controlConnections += 1;
    const passReply = machine.controlConnections >= holdLoginFrom
      ? undefined
      : machine.controlConnections >= refuseLoginFrom ? '530 Login incorrect' : '230 Logged in';
    answerCommands(socket, {
      passReply,
      pasvReply: nextPasvReply, epsvReply, nextDataSocket, replies, storReply, onUpload: text => { machine.uploadedText = text; }, commands: machine.commands, lines: machine.lines,
      sendFile: transfer => {
        machine.retrCount += 1;
        sendFile({ ...transfer, retrNumber: machine.retrCount });
      },
      sendListing: transfer => {
        machine.listCount += 1;
        sendListing({ ...transfer, retrNumber: machine.listCount });
      }
    });
  });
  const controlPort = await listen(controlServer, 0, controlHost);

  return {
    controlPort,
    dataPort,
    get dataConnections() { return machine.dataConnections; },
    get decoyConnections() { return machine.decoyConnections; },
    get uploadedText() { return machine.uploadedText; },
    get controlConnections() { return machine.controlConnections; },
    commands: machine.commands,
    lines: machine.lines,
    async close() {
      controlSockets.forEach(socket => socket.destroy());
      openDataSockets.forEach(socket => socket.destroy());
      const decoyClosed = decoyServer.listening ? closeServer(decoyServer) : Promise.resolve();
      await Promise.all([closeServer(controlServer), closeServer(dataServer), decoyClosed]);
    },
  };
}

/** After the PASV reply, the control socket tells this remote address */
function setControlAddressAfterPasv(address: string | undefined): void {
  const request = ftp.FTPContext.prototype.request;
  vi.spyOn(ftp.FTPContext.prototype, 'request').mockImplementation(async function (this: ftp.FTPContext, command: string) {
    const reply = await request.call(this, command);
    if (command === 'PASV') Object.defineProperty(this.socket, 'remoteAddress', { get: () => address });
    return reply;
  });
}

/** After the PASV reply, the control socket tells no remote address, as a socket that never connected does */
function forgetControlAddressAfterPasv(): void {
  setControlAddressAfterPasv(undefined);
}

/** The hosts of all the connections that the client starts */
function recordConnectHosts(): () => string[] {
  const connect = vi.spyOn(net.Socket.prototype, 'connect');
  return () => connect.mock.calls.map(([options, host]) =>
    typeof options === 'object' ? String((options as net.TcpNetConnectOpts).host) : String(host));
}

const realConnect = net.Socket.prototype.connect;

/**
 * The first `times` connections to this port never open, as when a firewall drops them.
 * The other connections open as usual.
 */
function neverConnectTo(port: number, times = Infinity): void {
  let dropped = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const [options] = args;
    const target = typeof options === 'object' ? (options as net.TcpNetConnectOpts).port : options;
    if (Number(target) === port && dropped < times) {
      dropped += 1;
      return this;
    }
    return (realConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
  });
}

/** A port on this computer where nothing listens */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server, 0, NAT_CONTROL_HOST);
  await closeServer(server);
  return port;
}

function collectText(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', chunk => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString();
}

describe.skipIf(!hasIpv6Loopback)('FTPClient data connection with a PASV reply that names another host', () => {
  let machine: FakeMachine | undefined;
  let ftpClient: FTPClient;

  beforeEach(async () => {
    machine = await startFakeMachine();
    ftpClient = new FTPClient({ host: CONTROL_HOST, port: machine.controlPort });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  it('downloads over a data connection to the machine host, not to the host of the reply', async () => {
    const destination = new PassThrough();
    const text = collectText(destination);

    await ftpClient.downloadFile('O1000', destination);

    expect(machine?.decoyConnections).toBe(0);
    expect(machine?.dataConnections).toBe(1);
    expect(text()).toBe(PROGRAM_TEXT);
  });

  it('reads the file tree over a data connection to the machine host, not to the host of the reply', async () => {
    const tree = await ftpClient.getFileTree('/', 1);

    expect(machine?.decoyConnections).toBe(0);
    expect(machine?.dataConnections).toBe(1);
    expect(tree.map(node => node.name)).toEqual(['O1000', 'O2000']);
  });

  it('lists a folder through basic-ftp over a data connection to the machine host only', async () => {
    const files = await ftpClient.listFiles('/');

    expect(machine?.decoyConnections).toBe(0);
    expect(machine?.dataConnections).toBe(1);
    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
  });

  // A socket that never connected has no remote address. With no host, a connection goes to this computer.
  // So the client must open no data connection at all.
  it('opens no data connection when the address of the control connection is not known', async () => {
    forgetControlAddressAfterPasv();

    await expect(ftpClient.downloadFile('O1000', new PassThrough())).rejects.toThrow('FTP download error');

    expect(machine?.decoyConnections).toBe(0);
    expect(machine?.dataConnections).toBe(0);
  });
});

describe('basic-ftp data connection with a PASV reply that names another host (a machine behind NAT)', () => {
  let machine: FakeMachine;
  let ftpClient: FTPClient;
  let connectHosts: () => string[];

  beforeEach(async () => {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });
    connectHosts = recordConnectHosts();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine.close();
  });

  it('uploads over a data connection to the machine host, not to the host of the reply', async () => {
    await ftpClient.uploadFile('O3000', PROGRAM_TEXT);

    expect(machine.uploadedText).toBe(PROGRAM_TEXT);
    // One LIST to find an existing file, then the STOR
    expect(machine.dataConnections).toBe(2);
    expect(connectHosts()).not.toContain(NAT_PASV_REPLY_HOST);
    // The client keeps PASV after EPSV failed once
    expect(machine.commands.filter(command => command === 'EPSV')).toHaveLength(1);
    expect(machine.commands.filter(command => command === 'PASV')).toHaveLength(2);
  });

  it('uploads when the PASV reply has no parentheses', async () => {
    await machine.close();
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, bareAddress: true });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });

    await ftpClient.uploadFile('O3000', PROGRAM_TEXT);

    expect(machine.uploadedText).toBe(PROGRAM_TEXT);
    expect(connectHosts()).not.toContain(NAT_PASV_REPLY_HOST);
  });

  it('uploads over EPSV, and sends no PASV, when the machine supports EPSV', async () => {
    await machine.close();
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, supportsEpsv: true });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });

    await ftpClient.uploadFile('O3000', PROGRAM_TEXT);

    expect(machine.uploadedText).toBe(PROGRAM_TEXT);
    expect(machine.dataConnections).toBe(2);
    expect(machine.commands).not.toContain('PASV');
  });

  it('lists a folder over a data connection to the machine host, not to the host of the reply', async () => {
    const files = await ftpClient.listFiles('/');

    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
    expect(machine.dataConnections).toBe(1);
    expect(connectHosts()).not.toContain(NAT_PASV_REPLY_HOST);
  });

  // The raw RETR fails at its PASV. Then the download of basic-ftp must also use only the machine host.
  it('downloads through basic-ftp over a data connection to the machine host when the raw RETR fails', async () => {
    await machine.close();
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, refuseFirstPasv: true });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });
    const destination = new PassThrough();
    const text = collectText(destination);

    await ftpClient.downloadFile('O1000', destination);

    expect(text()).toBe(PROGRAM_TEXT);
    // The refused PASV of the raw RETR, then EPSV and PASV of basic-ftp
    expect(machine.commands.filter(command => command === 'PASV')).toHaveLength(2);
    expect(machine.commands).toContain('EPSV');
    expect(machine.dataConnections).toBe(1);
    expect(machine.decoyConnections).toBe(0);
    expect(new Set(connectHosts())).toEqual(new Set([NAT_CONTROL_HOST]));
  });

  // The data connection of basic-ftp uses the timeout of the FTP client, so a dropped connection does not wait forever
  it('stops a basic-ftp data connection that does not open in the FTP timeout', async () => {
    const timeoutMs = 200;
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort, timeoutMs });
    neverConnectTo(machine.dataPort);
    const started = Date.now();

    await expect(ftpClient.listFiles('/')).rejects.toThrow('did not answer');

    expect(Date.now() - started).toBeLessThan(timeoutMs * 10);
    expect(machine.dataConnections).toBe(0);
  });

  it('gives the socket error when the basic-ftp data connection is refused', async () => {
    const port = await closedPort();
    await machine.close();
    machine = await startFakeMachine({
      controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST,
      pasvReplyFor: () => `227 Entering Passive Mode (192,0,2,1,${Math.floor(port / 256)},${port % 256})`
    });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });

    const failure = await ftpClient.listFiles('/').catch((err: unknown) => err);

    expect((failure as Error).cause).toMatchObject({ code: 'ECONNREFUSED', message: expect.stringContaining(`${NAT_CONTROL_HOST}:${port}`) });
    expect(connectHosts()).not.toContain(NAT_PASV_REPLY_HOST);
  });

  // Chatter never turns on FTP over TLS. The data connection of this file cannot use TLS, so it must not open as plain text.
  it('refuses to open a plain data connection when the control connection uses TLS', async () => {
    vi.spyOn(ftp.FTPContext.prototype, 'hasTLS', 'get').mockReturnValue(true);

    await expect(ftpClient.listFiles('/')).rejects.toThrow('Chatter does not support FTP over TLS');

    expect(machine.dataConnections).toBe(0);
  });

  // A dual-stack socket tells an IPv4 address as ::ffff:127.0.0.1. The data connection must use the plain IPv4 text.
  it('opens the download data connection to the plain IPv4 text of an IPv4-mapped control address', async () => {
    setControlAddressAfterPasv(`::ffff:${NAT_CONTROL_HOST}`);
    const destination = new PassThrough();
    const text = collectText(destination);

    await ftpClient.downloadFile('O1000', destination);

    expect(text()).toBe(PROGRAM_TEXT);
    expect(connectHosts()).toEqual([NAT_CONTROL_HOST, NAT_CONTROL_HOST]);
  });

  it('opens the basic-ftp data connection to the plain IPv4 text of an IPv4-mapped control address', async () => {
    setControlAddressAfterPasv(`::ffff:${NAT_CONTROL_HOST}`);

    const files = await ftpClient.listFiles('/');

    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
    expect(connectHosts()).toEqual([NAT_CONTROL_HOST, NAT_CONTROL_HOST]);
  });

  it('opens no data connection when the address of the control connection is not known', async () => {
    forgetControlAddressAfterPasv();

    await expect(ftpClient.listFiles('/')).rejects.toThrow('The control connection is closed');

    expect(machine.dataConnections).toBe(0);
    expect(connectHosts()).toEqual([NAT_CONTROL_HOST]);
  });
});

// The address bytes of these replies are not the machine. The client must use only the port, and connect only to the machine.
describe('FTPClient with a PASV reply that is not usual', () => {
  let machine: FakeMachine | undefined;
  let connectHosts: () => string[];

  beforeEach(() => {
    connectHosts = recordConnectHosts();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  async function clientFor(pasvReplyFor: (dataPort: number) => string): Promise<FTPClient> {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, pasvReplyFor });
    return new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });
  }

  function expectOnlyControlHost(): void {
    expect(machine?.decoyConnections).toBe(0);
    expect(new Set(connectHosts())).toEqual(new Set([NAT_CONTROL_HOST]));
  }

  const highByte = (port: number) => Math.floor(port / 256);
  const lowByte = (port: number) => port % 256;

  const refusedReplies = [
    { name: 'a reply with no numbers', reply: () => '227 Entering Passive Mode', error: 'Chatter cannot read the port in the PASV reply' },
    { name: 'a reply with port 0', reply: () => '227 Entering Passive Mode (192,0,2,1,0,0)', error: 'The PASV reply gives port 0' },
  ];

  it.each(refusedReplies)('refuses $name in a download, and opens no data connection', async ({ reply, error }) => {
    const ftpClient = await clientFor(reply);

    await expect(ftpClient.downloadFile('O1000', new PassThrough())).rejects.toThrow(error);

    expect(machine?.dataConnections).toBe(0);
    expectOnlyControlHost();
  });

  it.each(refusedReplies)('refuses $name in a basic-ftp list, and opens no data connection', async ({ reply, error }) => {
    const ftpClient = await clientFor(reply);

    await expect(ftpClient.listFiles('/')).rejects.toThrow(error);

    expect(machine?.dataConnections).toBe(0);
    expectOnlyControlHost();
  });

  // basic-ftp keeps only the low 8 bits of each port byte, so these replies give the port of the data listener.
  // For example, 300 gives 44 and -17 gives 239.
  const acceptedReplies = [
    {
      name: 'a port byte above 255',
      reply: (port: number) => `227 Entering Passive Mode (192,0,2,1,${highByte(port) + 256},${lowByte(port)})`,
    },
    {
      name: 'signed port bytes',
      reply: (port: number) => `227 Entering Passive Mode (10,0,0,1,${highByte(port) - 256},${lowByte(port) - 256})`,
    },
  ];

  it.each(acceptedReplies)('downloads with $name, over a connection to the machine host only', async ({ reply }) => {
    const ftpClient = await clientFor(reply);
    const destination = new PassThrough();
    const text = collectText(destination);

    await ftpClient.downloadFile('O1000', destination);

    expect(text()).toBe(PROGRAM_TEXT);
    expect(machine?.dataConnections).toBe(1);
    expectOnlyControlHost();
  });

  it.each(acceptedReplies)('lists a folder through basic-ftp with $name, over a connection to the machine host only', async ({ reply }) => {
    const ftpClient = await clientFor(reply);

    const files = await ftpClient.listFiles('/');

    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
    expect(machine?.dataConnections).toBe(1);
    expectOnlyControlHost();
  });
});

// The raw RETR and the raw LIST of FTPClient open their own data connection. When it does not open, they must
// stop after a short time and use the fallback of basic-ftp. In a tree walk, a long wait would come for each folder.
describe('FTPClient raw data connection that does not open', () => {
  const timeoutMs = 200;
  let machine: FakeMachine | undefined;
  let ftpClient: FTPClient;

  beforeEach(async () => {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort, timeoutMs });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  it('reads the file tree through the fallback when the raw LIST data connection does not open', async () => {
    neverConnectTo(machine?.dataPort ?? 0, 1);
    const started = Date.now();

    const tree = await ftpClient.getFileTree('/', 1);

    expect(tree.map(node => node.name)).toEqual(['O1000', 'O2000']);
    expect(Date.now() - started).toBeLessThan(timeoutMs * 10);
    // basic-ftp sends "LIST -a" in the fallback. Only that LIST got a data connection.
    expect(machine?.dataConnections).toBe(1);
  });

  it('downloads through the fallback when the raw RETR data connection does not open', async () => {
    neverConnectTo(machine?.dataPort ?? 0, 1);
    const destination = new PassThrough();
    const text = collectText(destination);
    const started = Date.now();

    await ftpClient.downloadFile('O1000', destination);

    expect(text()).toBe(PROGRAM_TEXT);
    expect(Date.now() - started).toBeLessThan(timeoutMs * 10);
    expect(machine?.dataConnections).toBe(1);
  });
});

// The raw RETR stops a download that gets no data. After the download ends, its timer must not stay active.
describe('FTPClient raw RETR timer', () => {
  let machine: FakeMachine | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  it.each([
    { name: 'a file with text', programText: PROGRAM_TEXT },
    { name: 'an empty file', programText: '' },
  ])('leaves no timer after the download of $name', async ({ programText }) => {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, programText });
    const ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });
    const destination = new PassThrough();
    const text = collectText(destination);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await ftpClient.downloadFile('O1000', destination);

    expect(text()).toBe(programText);
    expect(machine.commands).toContain('RETR');
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Resolve when the condition is true. It does not use vi.waitFor, because with fake timers vi.waitFor moves the
 * clock at each check. setImmediate and Date are not fake in these tests.
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition did not become true in 2 s');
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Start a download of O1000 from a new fake machine. `outcome` is 'success' or the error message. */
async function startDownload({ timeoutMs, limits, destination = new PassThrough(), signal, ...options }: FakeMachineOptions & {
  timeoutMs: number; limits?: Partial<DownloadLimits>; destination?: Writable; signal?: AbortSignal;
}) {
  const machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, ...options });
  const ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort, timeoutMs }, limits);
  const text = destination instanceof PassThrough ? collectText(destination) : () => '';
  const download = ftpClient.downloadFile('O1000', destination, signal);
  // Keep the result, so a rejection before the test reads it is not unhandled
  const outcome = download.then(() => 'success', (err: Error) => err.message);
  return { machine, text, outcome };
}

/** Wait for the next turn of the event loop, so the client can read what came on its sockets */
function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** True when the promise has settled. It waits some turns of the event loop first. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let isSettled = false;
  void promise.then(() => { isSettled = true; });
  for (let turn = 0; turn < 10; turn += 1) await nextTurn();
  return isSettled;
}

// A machine (or a rogue device) can send part of a file and then stop, with the data connection open. The raw RETR
// writes each byte to the user at once, so a cut file must fail, and it must never come back as a success.
describe('FTPClient raw RETR that stops in the middle of a file', () => {
  const timeoutMs = 200;
  const firstPart = PROGRAM_TEXT.slice(0, 8);
  let machine: FakeMachine | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  async function downloadFrom(sendFile: (transfer: FileTransfer) => void) {
    const download = await startDownload({ sendFile, timeoutMs });
    machine = download.machine;
    return download;
  }

  it('fails, and does not retry, when the machine sends part of the file and then goes silent', async () => {
    const { text, outcome } = await downloadFrom(({ data }) => data.write(firstPart));
    await until(() => text() === firstPart);

    vi.advanceTimersByTime(timeoutMs);

    expect(await outcome).toBe('FTP download error: The machine stopped sending the file. Try again.');
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('downloads a file that comes slowly, when each pause is shorter than the timeout', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => { transfer = started; });
    await until(() => transfer !== undefined);

    let sent = '';
    for (const letter of PROGRAM_TEXT) {
      vi.advanceTimersByTime(timeoutMs / 2);
      transfer?.data.write(letter);
      sent += letter;
      await until(() => text() === sent);
    }
    if (transfer) sendWholeFile(transfer, '');

    expect(await outcome).toBe('success');
    expect(text()).toBe(PROGRAM_TEXT);
    expect(vi.getTimerCount()).toBe(0);
  });

  // With no byte sent to the user, the fallback can start again on a new control connection, where no late reply
  // of the first RETR can arrive.
  it('downloads through the fallback on a new connection when the machine sends no byte and goes silent', async () => {
    const { text, outcome } = await downloadFrom(transfer => {
      if (transfer.retrNumber > 1) sendWholeFile(transfer, PROGRAM_TEXT);
    });
    await until(() => machine?.commands.includes('RETR') === true);

    vi.advanceTimersByTime(timeoutMs);

    expect(await outcome).toBe('success');
    expect(text()).toBe(PROGRAM_TEXT);
    expect(machine?.controlConnections).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Send the first part, wait until the user has it, then close the data connection and wait for the close */
  async function sendPartAndClose(text: () => string, transfer: FileTransfer): Promise<void> {
    transfer.data.write(firstPart);
    await until(() => text() === firstPart);
    await closeData(transfer);
  }

  /** The errors that basic-ftp gives when the machine closes the control connection */
  const CONTROL_CLOSED_ERROR = /^FTP download error: (Server sent FIN packet unexpectedly|Server closed connection unexpectedly)/;

  /** Close the control connection on the machine, and wait until the client closed it too */
  async function closeControl(transfer: FileTransfer | undefined): Promise<void> {
    let isClosed = false;
    transfer?.control.on('close', () => { isClosed = true; });
    transfer?.control.end();
    await until(() => isClosed);
  }

  /** Close the data connection on the machine, and wait until the client closed it too */
  async function closeData(transfer: FileTransfer): Promise<void> {
    let isClosed = false;
    transfer.data.on('close', () => { isClosed = true; });
    transfer.data.end();
    await until(() => isClosed);
  }

  // Some old, simple FTP servers never send the 226 after RETR. A clean end of the data connection is then the end
  // of the file. A late reply could go to the next command, so the client closes the control connection.
  it('downloads the file, and writes a warning, when the data connection ends but the machine sends no 226', async () => {
    const log = captureLog();
    try {
      let transfer: FileTransfer | undefined;
      const { text, outcome } = await downloadFrom(started => { transfer = started; });
      await until(() => transfer !== undefined);
      let isControlClosed = false;
      transfer?.control.on('close', () => { isControlClosed = true; });
      if (transfer) await sendPartAndClose(text, transfer);

      vi.advanceTimersByTime(timeoutMs);

      expect(await outcome).toBe('success');
      expect(text()).toBe(firstPart);
      await until(() => isControlClosed);
      const warnings = log.lines.filter(line => line.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].text).toContain('did not confirm');
      expect(warnings[0].text).toContain(`host=${NAT_CONTROL_HOST}`);
      expect(warnings[0].text).toContain('file=O1000');
      expect(warnings[0].text).toContain(`bytes=${firstPart.length}`);
      expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it('writes no warning when the 226 comes', async () => {
    const log = captureLog();
    try {
      const { outcome } = await downloadFrom(transfer => sendWholeFile(transfer, PROGRAM_TEXT));

      expect(await outcome).toBe('success');
      expect(log.text('warn')).toBe('');
    } finally {
      log.restore();
    }
  });

  it('waits only a short time for the 226 after the end of the data, also with a long FTP timeout', async () => {
    let transfer: FileTransfer | undefined;
    const download = await startDownload({ sendFile: started => { transfer = started; }, timeoutMs: 30_000 });
    machine = download.machine;
    await until(() => transfer !== undefined);
    if (transfer) await sendPartAndClose(download.text, transfer);

    vi.advanceTimersByTime(REPLY_AFTER_DATA_WAIT_MS - 1);
    expect(await hasSettled(download.outcome)).toBe(false);
    vi.advanceTimersByTime(1);

    expect(await download.outcome).toBe('success');
  });

  it.each([
    { code: 426, reply: '426 Connection closed; transfer aborted', error: '426 Connection closed; transfer aborted' },
    { code: 451, reply: '451 Local error in processing', error: '451 Local error in processing' },
    { code: 550, reply: '550 Transfer failed', error: '550 Transfer failed' },
    { code: 350, reply: '350 Restarting at 0', error: 'Unexpected reply to RETR: 350 Restarting at 0' },
  ])('fails when the data connection closes and the machine sends $code', async ({ reply, error }) => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => { transfer = started; });
    await until(() => transfer !== undefined);
    if (transfer) await sendPartAndClose(text, transfer);

    transfer?.control.write(`${reply}\r\n`);

    expect(await outcome).toBe(`FTP download error: ${error}`);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A machine can send the error reply before it closes the data connection. The bytes that come after the reply
  // are not part of a good file.
  it('fails, closes the data connection, and gives the user no later byte, when the 426 comes before the end of the data', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);
    let isClosed = false;
    transfer?.data.on('close', () => { isClosed = true; });
    let isSettled = false;
    void outcome.then(() => { isSettled = true; });

    transfer?.control.write('426 Connection closed; transfer aborted\r\n');

    // The download must end at the reply, not wait for the data connection to end. The wait has a limit, so a
    // client that waits for the data fails here, and not at the timeout of the test.
    await until(() => isSettled).catch(() => undefined);
    expect(isSettled).toBe(true);
    expect(await outcome).toBe('FTP download error: 426 Connection closed; transfer aborted');
    // write(), not end(): the machine keeps its side open, so only the client can close the data connection
    transfer?.data.write('LATE');
    await until(() => isClosed);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A closed control connection is not the reply of an old server that sends no 226. The file can be cut short.
  it('fails, and does not retry, when the machine closes the control connection after part of the file', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => { transfer = started; });
    await until(() => transfer !== undefined);
    if (transfer) await sendPartAndClose(text, transfer);

    await closeControl(transfer);
    // A client that waits for the reply would accept the file when this time is up
    vi.advanceTimersByTime(REPLY_AFTER_DATA_WAIT_MS);

    expect(await outcome).toMatch(CONTROL_CLOSED_ERROR);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A control can restart during a transfer. Then the control connection closes before the data connection ends.
  it('fails, closes the data connection, and does not retry, when the machine closes the control connection while the data comes', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);
    let isClosed = false;
    transfer?.data.on('close', () => { isClosed = true; });

    await closeControl(transfer);

    expect(await outcome).toMatch(CONTROL_CLOSED_ERROR);
    // write(), not end(): the machine keeps its side open, so only the client can close the data connection
    transfer?.data.write('LATE');
    await until(() => isClosed);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The client must close its data connection after a stall. Else the machine can go on sending to it.
  it('closes the data connection after a stall, and gives the user no byte that comes later', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);
    let isClosed = false;
    transfer?.data.on('close', () => { isClosed = true; });

    vi.advanceTimersByTime(timeoutMs);

    expect(await outcome).toBe('FTP download error: The machine stopped sending the file. Try again.');
    transfer?.data.write('LATE');
    await until(() => isClosed);
    expect(text()).toBe(firstPart);
  });

  it('gives the user no byte that comes after a stall, also before the data connection closes', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);
    // Keep the data connection of the client open, so later bytes can still come to it
    const realDestroy = net.Socket.prototype.destroy;
    const heldSockets: net.Socket[] = [];
    vi.spyOn(net.Socket.prototype, 'destroy').mockImplementation(function (this: net.Socket, ...args: [Error?]) {
      if (this.remotePort === machine?.dataPort && heldSockets.length === 0) {
        heldSockets.push(this);
        return this;
      }
      return realDestroy.apply(this, args);
    });

    vi.advanceTimersByTime(timeoutMs);

    expect(await outcome).toBe('FTP download error: The machine stopped sending the file. Try again.');
    transfer?.data.write('LATE');
    await until(() => heldSockets[0]?.bytesRead === firstPart.length + 'LATE'.length);
    expect(text()).toBe(firstPart);
    vi.restoreAllMocks();
    heldSockets[0]?.destroy();
  });

  it('downloads the whole file when the 226 comes before the end of the data', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);

    transfer?.control.write('226 Transfer complete\r\n');
    await nextTurn();
    transfer?.data.end(PROGRAM_TEXT.slice(firstPart.length));

    expect(await outcome).toBe('success');
    expect(text()).toBe(PROGRAM_TEXT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('downloads the whole file when the 226 comes some time after the end of the data', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => { transfer = started; });
    await until(() => transfer !== undefined);
    if (transfer) await sendPartAndClose(text, transfer);

    vi.advanceTimersByTime(timeoutMs / 2);
    transfer?.control.write('226 Transfer complete\r\n');

    expect(await outcome).toBe('success');
    expect(text()).toBe(firstPart);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails when the data connection breaks and the machine sends no 226', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => {
      transfer = started;
      started.data.write(firstPart);
    });
    await until(() => text() === firstPart);

    transfer?.data.resetAndDestroy();

    expect(await outcome).toMatch(/^FTP download error: .*ECONNRESET/);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The end of the data starts the wait for the reply again. Else a slow last chunk leaves too little time for the 226.
  it('starts the wait for the reply again when the data connection closes', async () => {
    let transfer: FileTransfer | undefined;
    const { text, outcome } = await downloadFrom(started => { transfer = started; });
    await until(() => transfer !== undefined);
    transfer?.data.write(firstPart);
    await until(() => text() === firstPart);
    vi.advanceTimersByTime(timeoutMs * 0.75);
    if (transfer) await closeData(transfer);

    vi.advanceTimersByTime(timeoutMs * 0.75);

    expect(await hasSettled(outcome)).toBe(false);
    transfer?.control.write('226 Transfer complete\r\n');
    expect(await outcome).toBe('success');
  });
});

/** Close the data connection on the machine, and wait until the client closed it too */
async function endData(transfer: FileTransfer): Promise<void> {
  let isClosed = false;
  transfer.data.on('close', () => { isClosed = true; });
  transfer.data.end();
  await until(() => isClosed);
}

// After the file, an FTP server must send a reply (usually 226). Some old servers send none, so after a short wait
// the client accepts a file whose data connection ended cleanly. A 426 that comes after this wait is never read. So
// the client asks for the size of the file (SIZE) before the RETR. With no reply, it accepts the file only when it
// has all the bytes of that size.
describe('FTPClient raw RETR with no reply after the data, and the SIZE of the file', () => {
  const timeoutMs = 200;
  const firstPart = PROGRAM_TEXT.slice(0, 8);
  const sizeReply = `213 ${PROGRAM_TEXT.length}`;
  let machine: FakeMachine | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  /** The machine sends `sent`, ends the data connection, and sends no reply to RETR */
  async function downloadWithNoReply({ sent, ...options }: FakeMachineOptions & { sent: string }) {
    let transfer: FileTransfer | undefined;
    const download = await startDownload({ sendFile: started => { transfer = started; }, timeoutMs, ...options });
    machine = download.machine;
    await until(() => transfer !== undefined);
    transfer?.data.write(sent);
    await until(() => download.text() === sent);
    if (transfer) await endData(transfer);
    vi.advanceTimersByTime(timeoutMs);
    return { ...download, transfer };
  }

  const retrCount = () => machine?.commands.filter(command => command === 'RETR').length;

  it('fails, and does not retry, when the data ends with fewer bytes than SIZE gave, and no reply comes', async () => {
    const { outcome, text } = await downloadWithNoReply({ sent: firstPart, replies: { SIZE: sizeReply } });

    expect(await outcome).toBe(`FTP download error: The file is not complete. The machine sent ${firstPart.length} of ${PROGRAM_TEXT.length} bytes. Try again.`);
    expect(text()).toBe(firstPart);
    expect(machine?.commands.indexOf('SIZE')).toBeGreaterThan(-1);
    expect(machine?.commands.indexOf('SIZE')).toBeLessThan(machine?.commands.indexOf('RETR') ?? -1);
    expect(retrCount()).toBe(1);
    expect(machine?.controlConnections).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A cut file has fewer bytes. A control can convert a program on the transfer, so its SIZE can be a little smaller.
  it('downloads the file with a warning, when the data ends with more bytes than SIZE gave, and no reply comes', async () => {
    const log = captureLog();
    try {
      const sent = `${PROGRAM_TEXT}X`;
      const { outcome, text } = await downloadWithNoReply({ sent, replies: { SIZE: sizeReply } });

      expect(await outcome).toBe('success');
      expect(text()).toBe(sent);
      expect(log.text('warn')).toContain('sent more bytes than SIZE gave');
      expect(retrCount()).toBe(1);
    } finally {
      log.restore();
    }
  });

  it('downloads the file, with no warning, when the data ends with all the bytes of SIZE and no reply comes', async () => {
    const log = captureLog();
    try {
      const { outcome, text, transfer } = await downloadWithNoReply({ sent: PROGRAM_TEXT, replies: { SIZE: sizeReply } });
      let isControlClosed = transfer?.control.destroyed === true;
      transfer?.control.on('close', () => { isControlClosed = true; });

      expect(await outcome).toBe('success');
      expect(text()).toBe(PROGRAM_TEXT);
      expect(log.text('warn')).toBe('');
      expect(machine?.commands).toContain('SIZE');
      // A late reply must not go to the next command
      await until(() => isControlClosed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.restore();
    }
  });

  // Each server that does not give a clear size keeps the old behavior: the file is accepted with a warning
  it.each([
    { name: 'refuses SIZE', reply: '502 SIZE is not supported' },
    { name: 'refuses SIZE in this mode', reply: '550 SIZE not allowed in ASCII mode' },
    { name: 'gives a size that is not a number', reply: '213 1,234' },
    { name: 'gives no size', reply: '213 ' },
    { name: 'answers SIZE with another code', reply: '200 OK' },
  ])('downloads the file with a warning, when the machine $name and no reply comes', async ({ reply }) => {
    const log = captureLog();
    try {
      const { outcome, text } = await downloadWithNoReply({ sent: firstPart, replies: { SIZE: reply } });

      expect(await outcome).toBe('success');
      expect(text()).toBe(firstPart);
      expect(log.text('warn')).toContain('did not confirm');
      expect(log.text('warn')).toContain('gave no size');
      expect(retrCount()).toBe(1);
    } finally {
      log.restore();
    }
  });

  // A limited server can ignore a command that it does not know. A late reply to SIZE must not go to the next command,
  // so the download goes on over a new connection, with no size.
  it('downloads the file over a new connection, with no size, when the machine sends no reply to SIZE', async () => {
    const log = captureLog();
    try {
      // The FTP timeout is long, so only the short wait for SIZE can end the wait
      const download = await startDownload({ timeoutMs: 30_000, replies: { SIZE: () => undefined } });
      machine = download.machine;
      await until(() => machine?.commands.includes('SIZE') === true);
      expect(await hasSettled(download.outcome)).toBe(false);

      vi.advanceTimersByTime(SIZE_REPLY_WAIT_MS);

      expect(await download.outcome).toBe('success');
      expect(download.text()).toBe(PROGRAM_TEXT);
      expect(machine.controlConnections).toBe(2);
      expect(machine.commands.filter(command => command === 'SIZE')).toHaveLength(1);
      // The raw RETR, not the fallback of basic-ftp (which tries EPSV first)
      expect(retrCount()).toBe(1);
      expect(machine.commands).not.toContain('EPSV');
      expect(log.text('warn')).toContain('gave no reply to SIZE');
    } finally {
      log.restore();
    }
  });

  it('downloads the file over a new connection, with no size, when the machine closes the connection on SIZE', async () => {
    const download = await startDownload({ timeoutMs, replies: { SIZE: control => control.destroy() } });
    machine = download.machine;

    expect(await download.outcome).toBe('success');
    expect(download.text()).toBe(PROGRAM_TEXT);
    expect(machine.controlConnections).toBe(2);
    expect(retrCount()).toBe(1);
    expect(machine.commands).not.toContain('EPSV');
  });

  it('does not log in again when the user stops the download while it waits for SIZE', async () => {
    const stop = new AbortController();
    const download = await startDownload({ timeoutMs: 30_000, replies: { SIZE: () => undefined }, signal: stop.signal });
    machine = download.machine;
    await until(() => machine?.commands.includes('SIZE') === true);

    stop.abort(new Error('The user stopped the download'));

    expect(await download.outcome).toBe('FTP download error: The user stopped the download');
    expect(machine.controlConnections).toBe(1);
    expect(machine.commands).not.toContain('RETR');
  });

  // The 226 is the answer of the machine. A server can give a size that is not the byte count, so SIZE does not count then.
  it('downloads the file when the 226 comes, also when SIZE gave another size', async () => {
    const download = await startDownload({ timeoutMs, replies: { SIZE: '213 999' } });
    machine = download.machine;

    expect(await download.outcome).toBe('success');
    expect(download.text()).toBe(PROGRAM_TEXT);
  });
});

const FOLDER_LINE = 'drwxr-xr-x 1 cnc cnc 0 Jan 01 12:00 SUB\r\n';
/** The start of a listing line, cut in the middle of the name O3000 */
const CUT_LINE = '-rw-r--r-- 1 cnc cnc 30 Jan 01 12:00 O30';
/** The listing of the folder SUB */
const SUB_LISTING = '-rw-r--r-- 1 cnc cnc 40 Jan 01 12:00 O4000\r\n';
const CUT_WARNING = 'ended before it was complete';

// The raw LIST must wait for the reply to LIST, as the raw RETR does. A 426 or 451 after part of a listing tells that
// the listing is cut short. A late reply must not go to the next command of the tree walk.
describe('FTPClient raw LIST that ends early', () => {
  const timeoutMs = 200;
  /** More than each wait of the raw LIST */
  const longWaitMs = 1_000;
  let machine: FakeMachine | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  /** Start a tree walk on a new fake machine. `tree` gives the tree, or the error message. */
  async function startTree(
    sendListing: (transfer: FileTransfer) => void,
    { depth = 1, timeoutMs: ftpTimeoutMs = timeoutMs, ...options }: FakeMachineOptions & { depth?: number; timeoutMs?: number } = {}
  ) {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, sendListing, ...options });
    const ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort, timeoutMs: ftpTimeoutMs });
    return { tree: ftpClient.readFileTree('/', depth).catch((err: Error) => err.message) };
  }

  /** Move the fake clock in small steps until the promise settles. For a wait whose start the test cannot see. */
  async function advanceUntilSettled(promise: Promise<unknown>): Promise<void> {
    let isSettled = false;
    void promise.then(() => { isSettled = true; });
    await until(() => {
      vi.advanceTimersByTime(100);
      return isSettled;
    });
  }

  /**
   * Record the delay of each timer that starts. The test then sees when the client starts a wait, with no fixed number
   * of event-loop turns. Call `restore` at the end of the test, before the clock is real again.
   * It is not a vi.spyOn: vi.restoreAllMocks runs after vi.useRealTimers, and would put the fake clock back.
   */
  function recordTimerDelays(): { delays: number[]; restore: () => void } {
    const delays: number[] = [];
    const fakeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return fakeSetTimeout(handler, ms);
    }) as typeof setTimeout;
    return { delays, restore: () => { globalThis.setTimeout = fakeSetTimeout; } };
  }

  /** The lines that the machine got on the last control connection, from its USER */
  const linesOfLastSession = () => machine?.lines.slice(machine.lines.findLastIndex(line => line.startsWith('USER'))) ?? [];

  /** The tree that the walk gave. A test fails when the walk gave an error. */
  async function treeOf(tree: Promise<unknown>): Promise<{ nodes: FTPTreeNode[]; isCutShort: boolean }> {
    const result = await tree;
    expect(result).toEqual(expect.objectContaining({ nodes: expect.any(Array) }));
    return result as { nodes: FTPTreeNode[]; isCutShort: boolean };
  }

  const listCount = () => machine?.commands.filter(command => command === 'LIST').length;
  const namesOf = (nodes: FTPTreeNode[]) => nodes.map(node => node.name);

  /** True from the time when the client closed its side of the data connection, so it has read all the data */
  function trackClose(data: net.Socket): () => boolean {
    let isClosed = data.destroyed;
    data.on('close', () => { isClosed = true; });
    return () => isClosed;
  }

  /** The tree must come with no move of the fake clock: no fixed wait is in the way */
  async function treeWithNoWait(tree: Promise<unknown>) {
    let isSettled = false;
    void tree.then(() => { isSettled = true; });
    await until(() => isSettled);
    return treeOf(tree);
  }

  it('reads the listing as soon as the 226 comes, with no fixed wait', async () => {
    const { tree } = await startTree(transfer => sendWholeFile(transfer, LISTING));

    const { nodes, isCutShort } = await treeWithNoWait(tree);
    expect(isCutShort).toBe(false);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Some servers do not close the data connection after the listing. After the 226, a short wait with no data ends it.
  it('reads the listing when the 226 comes and the data connection stays open', async () => {
    const timers = recordTimerDelays();
    try {
      const { tree } = await startTree(({ control, data }) => {
        data.write(LISTING);
        control.write('226 Transfer complete\r\n');
      }, { timeoutMs: 5_000 });
      await until(() => timers.delays.includes(1_000));
      expect(await hasSettled(tree)).toBe(false);

      vi.advanceTimersByTime(999);
      expect(await hasSettled(tree)).toBe(false);
      vi.advanceTimersByTime(1);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(false);
      expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
      expect(listCount()).toBe(1);
    } finally {
      timers.restore();
    }
  });

  it('waits again after the 226 when more data comes on the open data connection', async () => {
    const timers = recordTimerDelays();
    let transfer: FileTransfer | undefined;
    try {
      const { tree } = await startTree(started => {
        transfer = started;
        started.data.write(LISTING);
        started.control.write('226 Transfer complete\r\n');
      }, { timeoutMs: 5_000 });
      const replyWaits = () => timers.delays.filter(ms => ms === 1_000).length;
      await until(() => replyWaits() >= 1);
      vi.advanceTimersByTime(900);
      const waitsBefore = replyWaits();
      transfer?.data.write(SUB_LISTING);
      await until(() => replyWaits() > waitsBefore);

      vi.advanceTimersByTime(900);
      expect(await hasSettled(tree)).toBe(false);
      vi.advanceTimersByTime(100);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(false);
      expect(namesOf(nodes)).toEqual(['O1000', 'O2000', 'O4000']);
    } finally {
      timers.restore();
    }
  });

  it.each([
    { name: 'before', replyFirst: true },
    { name: 'after', replyFirst: false },
  ])('cuts the tree short, and drops the cut line, when a 426 comes $name the end of part of the listing', async ({ replyFirst }) => {
    const log = captureLog();
    try {
      const reply = '426 Connection closed; transfer aborted\r\n';
      const { tree } = await startTree(({ control, data }) => {
        if (replyFirst) control.write(reply, () => setImmediate(() => data.end(LISTING + CUT_LINE)));
        else data.end(LISTING + CUT_LINE, () => setImmediate(() => control.write(reply)));
      });

      const { nodes, isCutShort } = await treeWithNoWait(tree);
      expect(isCutShort).toBe(true);
      expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
      expect(log.text('warn')).toContain(CUT_WARNING);
      // The machine answered, so a second LIST would not help
      expect(listCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.restore();
    }
  });

  it('cuts the tree short when a 451 comes after part of the listing', async () => {
    const { tree } = await startTree(({ control, data }) => data.end(LISTING + CUT_LINE, () => {
      setImmediate(() => control.write('451 Local error in processing\r\n'));
    }));

    const { nodes, isCutShort } = await treeWithNoWait(tree);
    expect(isCutShort).toBe(true);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
  });

  // Some old servers send no reply to LIST, and no line end after the last line. A clean end of the data ends the
  // listing, as for a RETR with no reply.
  it('keeps the whole listing, also a last line with no line end, when the data ends cleanly and no reply comes', async () => {
    const log = captureLog();
    try {
      let isClosed: (() => boolean) | undefined;
      const { tree } = await startTree(({ data }) => {
        isClosed = trackClose(data);
        data.end(`${LISTING}${CUT_LINE}00`);
      });
      await until(() => isClosed?.() === true);

      expect(await hasSettled(tree)).toBe(false);
      vi.advanceTimersByTime(longWaitMs);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(false);
      expect(namesOf(nodes)).toEqual(['O1000', 'O2000', 'O3000']);
      expect(log.text('warn')).not.toContain(CUT_WARNING);
      expect(listCount()).toBe(1);
    } finally {
      log.restore();
    }
  });

  // Real timers: the client must read the data before its idle timer ends, and the test cannot see that read
  it('cuts the tree short when the machine stops in the middle of a listing', async () => {
    vi.useRealTimers();
    // The idle timer starts before the LIST, so it must be long, also on a slow CI computer
    const { tree } = await startTree(({ data }) => data.write(LISTING + CUT_LINE), { timeoutMs: 1_000 });

    const { nodes, isCutShort } = await treeOf(tree);
    expect(isCutShort).toBe(true);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
    // A second LIST would stop in the same way
    expect(listCount()).toBe(1);
  });

  it('keeps a last line with no line end when the 226 comes', async () => {
    const { tree } = await startTree(transfer => sendWholeFile(transfer, `${LISTING}O3000`));

    const { nodes, isCutShort } = await treeWithNoWait(tree);
    expect(isCutShort).toBe(false);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000', 'O3000']);
  });

  it('reads the whole listing when the 226 comes before the end of the data', async () => {
    const { tree } = await startTree(({ control, data }) => {
      data.write(LISTING.slice(0, 10));
      control.write('226 Transfer complete\r\n', () => setImmediate(() => data.end(LISTING.slice(10))));
    });

    const { nodes, isCutShort } = await treeWithNoWait(tree);
    expect(isCutShort).toBe(false);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
  });

  // Some old servers send no 226. The listing is complete when its data connection ends cleanly. A late 226 could
  // then be read as the reply to the next CWD, so the walk opens the next folder on a new connection.
  it('reads the next folder on a new connection after a listing with no reply', async () => {
    let first: FileTransfer | undefined;
    let isClosed: (() => boolean) | undefined;
    const { tree } = await startTree(transfer => {
      if (transfer.retrNumber > 1) {
        sendWholeFile(transfer, LISTING);
        return;
      }
      first = transfer;
      isClosed = trackClose(transfer.data);
      transfer.data.end(FOLDER_LINE + LISTING);
    }, { depth: 2 });
    await until(() => isClosed?.() === true);
    vi.advanceTimersByTime(longWaitMs);
    if (first && !first.control.destroyed) first.control.write('226 Transfer complete\r\n');

    const { nodes, isCutShort } = await treeOf(tree);
    expect(isCutShort).toBe(false);
    expect(namesOf(nodes)).toEqual(['SUB', 'O1000', 'O2000']);
    expect(namesOf(nodes[0].children ?? [])).toEqual(['O1000', 'O2000']);
    expect(machine?.controlConnections).toBe(2);
  });

  // A raw LIST that gets no reply closes the client. The new session starts in the login folder, so the fallback
  // must open the folder of the walk again.
  it.each([
    { name: 'the data connection breaks before the first byte', fail: (data: net.Socket) => data.resetAndDestroy(), waitMs: 0 },
    { name: 'no byte and no reply come in the FTP timeout', fail: () => undefined, waitMs: timeoutMs },
  ])('lists the right folder on a new connection when $name', async ({ fail, waitMs }) => {
    let failed: FileTransfer | undefined;
    const { tree } = await startTree(transfer => {
      if (transfer.retrNumber === 1) sendWholeFile(transfer, FOLDER_LINE + LISTING);
      else if (transfer.retrNumber === 2) {
        failed = transfer;
        fail(transfer.data);
      } else sendWholeFile(transfer, SUB_LISTING);
    }, { depth: 2 });
    await until(() => failed !== undefined);
    vi.advanceTimersByTime(waitMs);

    const { nodes, isCutShort } = await treeOf(tree);
    expect(namesOf(nodes)).toEqual(['SUB', 'O1000', 'O2000']);
    expect(namesOf(nodes[0].children ?? [])).toEqual(['O4000']);
    expect(isCutShort).toBe(false);
    expect(machine?.controlConnections).toBe(2);
    const session = linesOfLastSession();
    const cwd = session.indexOf('CWD /SUB');
    expect(cwd).toBeGreaterThan(-1);
    expect(cwd).toBeLessThan(session.findIndex(line => line.startsWith('LIST')));
  });

  // The walk keeps what it read, as for its other limits
  it('stops the walk and keeps the tree that it read, when the new login after a listing with no reply fails', async () => {
    const log = captureLog();
    try {
      let isClosed: (() => boolean) | undefined;
      const { tree } = await startTree(({ data }) => {
        isClosed = trackClose(data);
        data.end(FOLDER_LINE + LISTING);
      }, { depth: 2, refuseLoginFrom: 2 });
      await until(() => isClosed?.() === true);
      vi.advanceTimersByTime(longWaitMs);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(true);
      expect(namesOf(nodes)).toEqual(['SUB', 'O1000', 'O2000']);
      expect(nodes[0].children).toEqual([]);
      expect(machine?.controlConnections).toBe(2);
      expect(log.text('warn')).toContain('could not log in again');
    } finally {
      log.restore();
    }
  });

  it('stops the walk and keeps the tree that it read, when the time limit comes during the new login', async () => {
    const log = captureLog();
    try {
      let isClosed: (() => boolean) | undefined;
      // The FTP timeout is longer than the time limit, so only the time limit can stop the login
      const { tree } = await startTree(({ data }) => {
        isClosed = trackClose(data);
        data.end(FOLDER_LINE + LISTING);
      }, { depth: 2, holdLoginFrom: 2, timeoutMs: 2 * TREE_WALK_TIME_LIMIT_MS });
      await until(() => isClosed?.() === true);
      vi.advanceTimersByTime(longWaitMs);
      await until(() => machine?.commands.filter(command => command === 'PASS').length === 2);

      vi.advanceTimersByTime(TREE_WALK_TIME_LIMIT_MS);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(true);
      expect(namesOf(nodes)).toEqual(['SUB', 'O1000', 'O2000']);
      expect(nodes[0].children).toEqual([]);
      expect(log.text('warn')).toContain('took too long');
    } finally {
      log.restore();
    }
  });

  it('does not log in again when the time limit comes during a listing with no byte', async () => {
    const log = captureLog();
    try {
      const { tree } = await startTree(() => undefined, { timeoutMs: 2 * TREE_WALK_TIME_LIMIT_MS });
      await until(() => listCount() === 1);

      vi.advanceTimersByTime(TREE_WALK_TIME_LIMIT_MS);
      await advanceUntilSettled(tree);

      const { nodes, isCutShort } = await treeOf(tree);
      expect(isCutShort).toBe(true);
      expect(nodes).toEqual([]);
      expect(machine?.controlConnections).toBe(1);
      expect(listCount()).toBe(1);
      expect(log.text('warn')).toContain('took too long');
    } finally {
      log.restore();
    }
  });

  it('reads the listing through the fallback when the machine refuses the LIST after its 150 and sends no byte', async () => {
    const { tree } = await startTree(transfer => {
      if (transfer.retrNumber > 1) {
        sendWholeFile(transfer, LISTING);
        return;
      }
      transfer.control.write('450 Folder busy\r\n');
      transfer.data.end();
    });

    const { nodes } = await treeWithNoWait(tree);
    expect(namesOf(nodes)).toEqual(['O1000', 'O2000']);
    // The raw LIST, then the "LIST -a" of basic-ftp
    expect(listCount()).toBe(2);
  });
});

// basic-ftp waits for the reply after the data of STOR. A 426 there tells that the program on the machine is not
// complete, so the upload must fail. The cut file stays on the machine.
describe('FTPClient upload that the machine ends with an error', () => {
  const reply = '426 Connection closed; transfer aborted';
  let machine: FakeMachine;
  let ftpClient: FTPClient;

  beforeEach(async () => {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, storReply: reply });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort });
  });

  afterEach(async () => {
    await machine.close();
  });

  it('fails the upload when the machine sends 426 after the data of STOR', async () => {
    await expect(ftpClient.uploadFile('O3000', PROGRAM_TEXT)).rejects.toThrow(`FTP upload error: ${reply}`);

    expect(machine.uploadedText).toBe(PROGRAM_TEXT);
  });

  it('gives the file as failed in a batch upload when the machine sends 426 after the data of STOR', async () => {
    const result = await ftpClient.uploadFiles([{ remotePath: 'O3000', source: PROGRAM_TEXT }]);

    expect(result).toEqual({ success: [], failed: [{ remotePath: 'O3000', error: reply }] });
    expect(machine.uploadedText).toBe(PROGRAM_TEXT);
  });
});

// The same checks with real timers. A fake clock cannot show a timer of a socket, such as the timeout of the control
// connection. The margins are large, so a slow CI computer does not make the test fail.
describe('FTPClient raw RETR with real timers', () => {
  const timeoutMs = 300;
  const pauseMs = 40;
  let machine: FakeMachine | undefined;

  afterEach(async () => {
    await machine?.close();
    machine = undefined;
  });

  it('downloads a file that comes in small parts for much longer than the timeout', async () => {
    let transfer: FileTransfer | undefined;
    const download = await startDownload({ sendFile: started => { transfer = started; }, timeoutMs });
    machine = download.machine;
    await until(() => transfer !== undefined);
    const started = Date.now();

    for (const letter of PROGRAM_TEXT) {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
      transfer?.data.write(letter);
    }
    if (transfer) sendWholeFile(transfer, '');

    expect(await download.outcome).toBe('success');
    expect(download.text()).toBe(PROGRAM_TEXT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeoutMs * 2);
  });
});

// A refused RETR (for example 550, no such file) is a clear answer. A second RETR on a new connection gets the same
// answer, and a failed second login would hide the real reason.
describe('FTPClient raw RETR that the machine refuses', () => {
  const timeoutMs = 200;
  let machine: FakeMachine | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  /** The machine answers each RETR in `replies` (by its number) with that reply. Other RETRs get the file. */
  function refuseRetr(replies: Record<number, string>) {
    return (transfer: FileTransfer) => {
      const reply = replies[transfer.retrNumber];
      if (reply === undefined) {
        sendWholeFile(transfer, PROGRAM_TEXT);
        return;
      }
      transfer.control.write(`${reply}\r\n`);
      transfer.data.end();
    };
  }

  const retrCount = () => machine?.commands.filter(command => command === 'RETR').length;

  it.each([
    { reply: '550 No such file' },
    { reply: '450 File busy' },
    { reply: '426 Connection closed; transfer aborted' },
  ])('fails with the reply, and runs no fallback, when the machine answers RETR with $reply', async ({ reply }) => {
    const download = await startDownload({ sendFile: refuseRetr({ 1: reply }), timeoutMs });
    machine = download.machine;

    expect(await download.outcome).toBe(`FTP download error: ${reply}`);
    expect(retrCount()).toBe(1);
    expect(machine.controlConnections).toBe(1);
  });

  it('runs the fallback when the machine cannot open the data connection for the raw RETR (425)', async () => {
    const download = await startDownload({ sendFile: refuseRetr({ 1: '425 Cannot open data connection' }), timeoutMs });
    machine = download.machine;

    expect(await download.outcome).toBe('success');
    expect(download.text()).toBe(PROGRAM_TEXT);
    expect(retrCount()).toBe(2);
  });

  it('gives the error of the raw RETR when the second login of the fallback fails', async () => {
    const download = await startDownload({
      sendFile: refuseRetr({ 1: '425 Cannot open data connection' }), refuseLoginFrom: 2, timeoutMs
    });
    machine = download.machine;

    expect(await download.outcome).toBe('FTP download error: 425 Cannot open data connection');
    expect(machine.controlConnections).toBe(2);
  });

  it('gives the error of the fallback when the fallback RETR fails', async () => {
    const download = await startDownload({
      sendFile: refuseRetr({ 1: '425 Cannot open data connection', 2: '550 No such file' }), timeoutMs
    });
    machine = download.machine;

    expect(await download.outcome).toBe('FTP download error: 550 No such file');
    expect(retrCount()).toBe(2);
  });
});

// A machine (or a rogue device) can send one byte just before each timeout, or a file with no end. One download
// must stop after a time limit and a byte limit, on the raw RETR and on the fallback, and close its connections.
describe('FTPClient download limits', () => {
  let machine: FakeMachine | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  /** The first RETR gets 425, so the fallback runs. The second RETR does what `sendFile` does. */
  function fallbackThat(sendFile: (transfer: FileTransfer) => void) {
    return (transfer: FileTransfer) => {
      if (transfer.retrNumber > 1) {
        sendFile(transfer);
        return;
      }
      transfer.control.write('425 Cannot open data connection\r\n');
      transfer.data.end();
    };
  }

  it('stops a raw RETR that sends one byte just before each timeout, at the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeoutMs = 200;
    let transfer: FileTransfer | undefined;
    const download = await startDownload({ sendFile: started => { transfer = started; }, timeoutMs, limits: { timeLimitMs: 1_000 } });
    machine = download.machine;
    await until(() => transfer !== undefined);
    let isDataClosed = false;
    transfer?.data.on('close', () => { isDataClosed = true; });

    for (let sent = 1; sent <= 6; sent += 1) {
      transfer?.data.write('X');
      await until(() => download.text().length === sent);
      vi.advanceTimersByTime(timeoutMs - 10);
    }

    expect(await download.outcome).toBe('FTP download error: The download took too long. Chatter stops a download after 1 second.');
    await until(() => isDataClosed);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a fallback download that does not end, at the time limit', async () => {
    let transfer: FileTransfer | undefined;
    const download = await startDownload({
      sendFile: fallbackThat(started => {
        transfer = started;
        started.data.write('X');
      }),
      timeoutMs: 5_000, limits: { timeLimitMs: 300 }
    });
    machine = download.machine;
    const started = Date.now();

    expect(await download.outcome).toBe('FTP download error: The download took too long. Chatter stops a download after 0.3 seconds.');
    expect(Date.now() - started).toBeLessThan(3_000);
    let isDataClosed = transfer?.data.destroyed === true;
    transfer?.data.on('close', () => { isDataClosed = true; });
    await until(() => isDataClosed);
  });

  // After the time limit, the fallback must not log in again: it would download with no time limit
  it('runs no fallback when the time limit comes before the first byte', async () => {
    const download = await startDownload({
      sendFile: transfer => {
        if (transfer.retrNumber > 1) sendWholeFile(transfer, PROGRAM_TEXT);
      },
      timeoutMs: 5_000, limits: { timeLimitMs: 300 }
    });
    machine = download.machine;

    expect(await download.outcome).toBe('FTP download error: The download took too long. Chatter stops a download after 0.3 seconds.');
    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(machine.controlConnections).toBe(1);
  });

  it('stops a raw RETR at the byte limit, and gives the user no byte over the limit', async () => {
    let transfer: FileTransfer | undefined;
    const download = await startDownload({
      sendFile: started => {
        transfer = started;
        started.data.write(PROGRAM_TEXT);
      },
      timeoutMs: 5_000, limits: { maxBytes: 10 }
    });
    machine = download.machine;

    expect(await download.outcome).toBe('FTP download error: The file on the machine is too large. Chatter downloads at most 10 bytes.');
    expect(download.text().length).toBeLessThanOrEqual(10);
    let isDataClosed = transfer?.data.destroyed === true;
    transfer?.data.on('close', () => { isDataClosed = true; });
    await until(() => isDataClosed);
    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
  });

  it('stops a fallback download at the byte limit', async () => {
    const download = await startDownload({
      sendFile: fallbackThat(transfer => sendWholeFile(transfer, PROGRAM_TEXT)), timeoutMs: 5_000, limits: { maxBytes: 10 }
    });
    machine = download.machine;

    expect(await download.outcome).toBe('FTP download error: The file on the machine is too large. Chatter downloads at most 10 bytes.');
    expect(download.text().length).toBeLessThanOrEqual(10);
  });

  it('downloads a file of exactly the byte limit', async () => {
    const download = await startDownload({ timeoutMs: 5_000, limits: { maxBytes: PROGRAM_TEXT.length } });
    machine = download.machine;

    expect(await download.outcome).toBe('success');
    expect(download.text()).toBe(PROGRAM_TEXT);
  });
});

/** A destination that takes each chunk only when the test lets it, as a slow browser does */
function slowDestination() {
  const waiting: Array<() => void> = [];
  const chunks: Buffer[] = [];
  const destination = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      waiting.push(done);
    },
  });
  return {
    destination,
    /** The bytes that wait in memory, and the bytes that the destination took */
    heldBytes: () => destination.writableLength,
    text: () => Buffer.concat(chunks).toString(),
    /** Take all chunks from now on */
    release() {
      destination._write = (chunk: Buffer, _encoding, done) => {
        chunks.push(chunk);
        done();
      };
      waiting.splice(0).forEach(done => done());
    },
  };
}

// The download goes to the HTTP reply. When the browser reads slowly, the raw RETR must stop to read from the machine,
// so the file does not wait in the memory of a Pi.
describe('FTPClient raw RETR to a slow destination', () => {
  let machine: FakeMachine | undefined;

  afterEach(async () => {
    await machine?.close();
    machine = undefined;
  });

  const bigText = 'G01 X1 Y1\n'.repeat(1_600_000);

  it.each([
    { name: 'the raw RETR', sendFile: (transfer: FileTransfer) => sendWholeFile(transfer, bigText) },
    {
      name: 'the fallback',
      sendFile: (transfer: FileTransfer) => {
        if (transfer.retrNumber > 1) {
          sendWholeFile(transfer, bigText);
          return;
        }
        transfer.control.write('425 Cannot open data connection\r\n');
        transfer.data.end();
      }
    },
  ])('stops to read from the machine in $name while the destination is full, and does not time out', async ({ sendFile }) => {
    const slow = slowDestination();
    const download = await startDownload({ sendFile, timeoutMs: 100, destination: slow.destination });
    machine = download.machine;

    await new Promise(resolve => setTimeout(resolve, 400));

    expect(slow.heldBytes()).toBeLessThan(4 * 1024 * 1024);
    expect(await hasSettled(download.outcome)).toBe(false);
    slow.release();
    expect(await download.outcome).toBe('success');
    expect(slow.text()).toBe(bigText);
  });
});

// A rogue machine can send a folder listing with no end. Each list must stop at MAX_FOLDER_LIST_BYTES, so the
// listing cannot fill the memory of a Pi. The listing has folders, so a walk that goes on would open them.
describe('FTPClient folder listing that is too long', () => {
  const timeoutMs = 200;
  const folderLine = (index: number) => `drwxr-xr-x 1 cnc cnc 0 Jan 01 12:00 D${String(index).padStart(60, '0')}\r\n`;
  const longListing = Array.from({ length: Math.ceil((MAX_FOLDER_LIST_BYTES * 2) / folderLine(0).length) }, (_, index) => folderLine(index)).join('');
  let machine: FakeMachine | undefined;
  let ftpClient: FTPClient;

  beforeEach(async () => {
    machine = await startFakeMachine({ controlHost: NAT_CONTROL_HOST, pasvReplyHost: NAT_PASV_REPLY_HOST, listing: longListing });
    ftpClient = new FTPClient({ host: NAT_CONTROL_HOST, port: machine.controlPort, timeoutMs });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    machine = undefined;
  });

  const count = (command: string) => machine?.commands.filter(sent => sent === command).length;

  it('cuts the tree, runs no fallback and opens no more folders after a raw listing that is too long', async () => {
    const tree = await ftpClient.readFileTree('/', 2);

    expect(tree.isCutShort).toBe(true);
    expect(tree.nodes.length).toBeGreaterThan(0);
    expect(tree.nodes.length * folderLine(0).length).toBeLessThanOrEqual(MAX_FOLDER_LIST_BYTES);
    // Only the raw LIST: no "LIST -a" of basic-ftp, and no LIST in a folder of the listing
    expect(count('LIST')).toBe(1);
    expect(count('CWD')).toBe(1);
  });

  it('cuts the tree and opens no more folders after a fallback listing that is too long', async () => {
    neverConnectTo(machine?.dataPort ?? 0, 1);

    const tree = await ftpClient.readFileTree('/', 2);

    expect(tree).toEqual({ nodes: [], isCutShort: true });
    // The raw LIST got no data connection, so it sent no LIST. Then the "LIST -a" of basic-ftp got the long listing.
    expect(count('LIST')).toBe(1);
    expect(count('CWD')).toBe(1);
  });

  it('refuses to list a folder whose listing is too long', async () => {
    await expect(ftpClient.listFiles('/')).rejects.toThrow('The folder list on the machine is too long');
  });

  // When Chatter cannot read the folder, it cannot know if the file is there. It must not write over a program.
  it('does not upload when the folder listing is too long to check for the file', async () => {
    await expect(ftpClient.uploadFile('O3000', PROGRAM_TEXT)).rejects.toThrow('The folder list on the machine is too long');

    expect(machine?.commands).not.toContain('STOR');
  });

  it('gives the file that is too long to check as a failed file of a batch upload', async () => {
    const result = await ftpClient.uploadFiles([{ remotePath: 'O3000', source: PROGRAM_TEXT }]);

    expect(result.success).toEqual([]);
    expect(result.failed).toEqual([{ remotePath: 'O3000', error: expect.stringContaining('The folder list on the machine is too long') }]);
    expect(machine?.commands).not.toContain('STOR');
  });
});
