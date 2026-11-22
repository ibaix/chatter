import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import * as ftp from 'basic-ftp';
import { FTPClient } from './FTPClient.js';

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
  /** Data connections that arrived at the control host */
  dataConnections: number;
  /** Data connections that arrived at the host of the PASV reply */
  decoyConnections: number;
  /** The text of the last STOR */
  uploadedText: string;
  /** The first word of each command that the machine got */
  commands: string[];
  close(): Promise<void>;
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

function readAll(socket: net.Socket): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk));
  return new Promise(resolve => socket.on('end', () => resolve(Buffer.concat(chunks).toString())));
}

/** Reply to the commands of FTPClient and basic-ftp. RETR, LIST and STOR use the next data connection. */
function answerCommands(socket: net.Socket, { pasvReply, epsvReply, nextDataSocket, onUpload, commands }: {
  pasvReply: string;
  epsvReply: string;
  nextDataSocket: () => Promise<net.Socket>;
  onUpload: (text: string) => void;
  commands: string[];
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
      if (command === 'USER') socket.write('331 Password\r\n');
      else if (command === 'PASS') socket.write('230 Logged in\r\n');
      else if (command === 'PASV') socket.write(`${pasvReply}\r\n`);
      else if (command === 'EPSV') socket.write(`${epsvReply}\r\n`);
      else if (command === 'PWD') socket.write('257 "/"\r\n');
      else if (command === 'CWD') socket.write('250 OK\r\n');
      else if (command === 'RETR' || command === 'LIST') {
        socket.write('150 Opening data connection\r\n');
        const dataSocket = await nextDataSocket();
        dataSocket.end(command === 'RETR' ? PROGRAM_TEXT : LISTING, () => socket.write('226 Transfer complete\r\n'));
      } else if (command === 'STOR') {
        socket.write('150 Ready for data\r\n');
        onUpload(await readAll(await nextDataSocket()));
        socket.write('226 Transfer complete\r\n');
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
}

/** A decoy listens at the host of the PASV reply only when that host is on this computer */
async function startFakeMachine({
  controlHost = CONTROL_HOST, pasvReplyHost = PASV_REPLY_HOST, supportsEpsv = false, bareAddress = false, pasvReplyFor
}: FakeMachineOptions = {}): Promise<FakeMachine> {
  const dataSockets: net.Socket[] = [];
  const dataWaiters: Array<(socket: net.Socket) => void> = [];
  const machine = { dataConnections: 0, decoyConnections: 0, uploadedText: '', commands: [] as string[] };

  const dataServer = net.createServer(socket => {
    machine.dataConnections += 1;
    socket.on('error', () => undefined);
    const waiter = dataWaiters.shift();
    if (waiter) waiter(socket);
    else dataSockets.push(socket);
  });
  const dataPort = await listen(dataServer, 0, controlHost);

  const decoyServer = net.createServer(socket => {
    machine.decoyConnections += 1;
    socket.on('error', () => undefined);
    socket.end();
  });
  if (pasvReplyHost === PASV_REPLY_HOST) await listen(decoyServer, dataPort, pasvReplyHost);

  const address = `${pasvReplyHost.replaceAll('.', ',')},${Math.floor(dataPort / 256)},${dataPort % 256}`;
  const pasvReply = pasvReplyFor?.(dataPort) ?? `227 Entering Passive Mode ${bareAddress ? address : `(${address})`}`;
  const epsvReply = supportsEpsv ? `229 Entering Extended Passive Mode (|||${dataPort}|)` : '500 Not supported';
  const nextDataSocket = () => new Promise<net.Socket>(resolve => {
    const socket = dataSockets.shift();
    if (socket) resolve(socket);
    else dataWaiters.push(resolve);
  });

  const controlSockets = new Set<net.Socket>();
  const controlServer = net.createServer(socket => {
    controlSockets.add(socket);
    answerCommands(socket, {
      pasvReply, epsvReply, nextDataSocket, onUpload: text => { machine.uploadedText = text; }, commands: machine.commands
    });
  });
  const controlPort = await listen(controlServer, 0, controlHost);

  return {
    controlPort,
    get dataConnections() { return machine.dataConnections; },
    get decoyConnections() { return machine.decoyConnections; },
    get uploadedText() { return machine.uploadedText; },
    commands: machine.commands,
    async close() {
      controlSockets.forEach(socket => socket.destroy());
      const decoyClosed = decoyServer.listening ? closeServer(decoyServer) : Promise.resolve();
      await Promise.all([closeServer(controlServer), closeServer(dataServer), decoyClosed]);
    },
  };
}

/** After the PASV reply, the control socket tells no remote address, as a socket that never connected does */
function forgetControlAddressAfterPasv(): void {
  const request = ftp.FTPContext.prototype.request;
  vi.spyOn(ftp.FTPContext.prototype, 'request').mockImplementation(async function (this: ftp.FTPContext, command: string) {
    const reply = await request.call(this, command);
    if (command === 'PASV') Object.defineProperty(this.socket, 'remoteAddress', { get: () => undefined });
    return reply;
  });
}

/** The hosts of all the connections that the client starts */
function recordConnectHosts(): () => string[] {
  const connect = vi.spyOn(net.Socket.prototype, 'connect');
  return () => connect.mock.calls.map(([options, host]) =>
    typeof options === 'object' ? String((options as net.TcpNetConnectOpts).host) : String(host));
}

function collectText(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', chunk => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString();
}

describe('FTPClient data connection with a PASV reply that names another host', () => {
  let machine: FakeMachine;
  let ftpClient: FTPClient;

  beforeEach(async () => {
    machine = await startFakeMachine();
    ftpClient = new FTPClient({ host: CONTROL_HOST, port: machine.controlPort });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine.close();
  });

  it('downloads over a data connection to the machine host, not to the host of the reply', async () => {
    const destination = new PassThrough();
    const text = collectText(destination);

    await ftpClient.downloadFile('O1000', destination);

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(1);
    expect(text()).toBe(PROGRAM_TEXT);
  });

  it('reads the file tree over a data connection to the machine host, not to the host of the reply', async () => {
    const tree = await ftpClient.getFileTree('/', 1);

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(1);
    expect(tree.map(node => node.name)).toEqual(['O1000', 'O2000']);
  });

  it('lists a folder through basic-ftp over a data connection to the machine host only', async () => {
    const files = await ftpClient.listFiles('/');

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(1);
    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
  });

  // A socket that never connected has no remote address. With no host, a connection goes to this computer.
  // So the client must open no data connection at all.
  it('opens no data connection when the address of the control connection is not known', async () => {
    forgetControlAddressAfterPasv();

    await expect(ftpClient.downloadFile('O1000', new PassThrough())).rejects.toThrow('FTP download error');

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(0);
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
