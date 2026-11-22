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

const CONTROL_HOST = '::1';
const PASV_REPLY_HOST = '127.0.0.1';
const PROGRAM_TEXT = '%\nO1000\nG00 X0\nM30\n%\n';
const LISTING = '-rw-r--r-- 1 cnc cnc 20 Jan 01 12:00 O1000\r\n-rw-r--r-- 1 cnc cnc 30 Jan 01 12:00 O2000\r\n';

interface FakeMachine {
  controlPort: number;
  /** Data connections that arrived at the control host */
  dataConnections: number;
  /** Data connections that arrived at the host of the PASV reply */
  decoyConnections: number;
  close(): Promise<void>;
}

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only: host === CONTROL_HOST }, () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** Reply to the commands of FTPClient and basic-ftp. RETR and LIST send their data on the last data connection. */
function answerCommands(socket: net.Socket, { pasvReply, nextDataSocket }: {
  pasvReply: string;
  nextDataSocket: () => Promise<net.Socket>;
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
      if (command === 'USER') socket.write('331 Password\r\n');
      else if (command === 'PASS') socket.write('230 Logged in\r\n');
      else if (command === 'PASV') socket.write(`${pasvReply}\r\n`);
      else if (command === 'EPSV') socket.write('500 Not supported\r\n');
      else if (command === 'PWD') socket.write('257 "/"\r\n');
      else if (command === 'CWD') socket.write('250 OK\r\n');
      else if (command === 'RETR' || command === 'LIST') {
        socket.write('150 Opening data connection\r\n');
        const dataSocket = await nextDataSocket();
        dataSocket.end(command === 'RETR' ? PROGRAM_TEXT : LISTING, () => socket.write('226 Transfer complete\r\n'));
      } else socket.write('200 OK\r\n');
    }
  });
  socket.on('error', () => undefined);
}

async function startFakeMachine(): Promise<FakeMachine> {
  const dataSockets: net.Socket[] = [];
  const dataWaiters: Array<(socket: net.Socket) => void> = [];
  const machine = { dataConnections: 0, decoyConnections: 0 };

  const dataServer = net.createServer(socket => {
    machine.dataConnections += 1;
    socket.on('error', () => undefined);
    const waiter = dataWaiters.shift();
    if (waiter) waiter(socket);
    else dataSockets.push(socket);
  });
  const dataPort = await listen(dataServer, 0, CONTROL_HOST);

  const decoyServer = net.createServer(socket => {
    machine.decoyConnections += 1;
    socket.on('error', () => undefined);
    socket.end();
  });
  await listen(decoyServer, dataPort, PASV_REPLY_HOST);

  const pasvReply = `227 Entering Passive Mode (${PASV_REPLY_HOST.replaceAll('.', ',')},${Math.floor(dataPort / 256)},${dataPort % 256})`;
  const nextDataSocket = () => new Promise<net.Socket>(resolve => {
    const socket = dataSockets.shift();
    if (socket) resolve(socket);
    else dataWaiters.push(resolve);
  });

  const controlSockets = new Set<net.Socket>();
  const controlServer = net.createServer(socket => {
    controlSockets.add(socket);
    answerCommands(socket, { pasvReply, nextDataSocket });
  });
  const controlPort = await listen(controlServer, 0, CONTROL_HOST);

  return {
    controlPort,
    get dataConnections() { return machine.dataConnections; },
    get decoyConnections() { return machine.decoyConnections; },
    async close() {
      controlSockets.forEach(socket => socket.destroy());
      await Promise.all([closeServer(controlServer), closeServer(dataServer), closeServer(decoyServer)]);
    },
  };
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

  // basic-ftp makes these data connections. Its default also uses the machine host. This test keeps that default.
  it('lists a folder through basic-ftp over a data connection to the machine host only', async () => {
    const files = await ftpClient.listFiles('/');

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(1);
    expect(files.map(file => file.name)).toEqual(['O1000', 'O2000']);
  });

  // A socket that never connected has no remote address. With no host, a connection goes to this computer.
  // So the client must open no data connection at all.
  it('opens no data connection when the address of the control connection is not known', async () => {
    const send = ftp.Client.prototype.send;
    vi.spyOn(ftp.Client.prototype, 'send').mockImplementation(async function (this: ftp.Client, command: string) {
      const reply = await send.call(this, command);
      if (command === 'PASV') Object.defineProperty(this.ftp.socket, 'remoteAddress', { get: () => undefined });
      return reply;
    });

    await expect(ftpClient.downloadFile('O1000', new PassThrough())).rejects.toThrow('FTP download error');

    expect(machine.decoyConnections).toBe(0);
    expect(machine.dataConnections).toBe(0);
  });
});
