import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import { FTPClient } from './FTPClient.js';

// When the user cancels a program download, Chatter must stop the transfer on the machine too.
// Else the machine sends the rest of the file to nobody, and its FTP connection stays busy.
//
// The fake machine below sends a file that never ends: one chunk on each tick, until the data connection closes.

const HOST = '127.0.0.1';
const CHUNK_INTERVAL_MS = 10;
/** A stopped download ends in much less time than this */
const STOP_LIMIT_MS = 1_000;

interface EndlessMachine {
  port: number;
  /** The first word of each command that the machine got */
  commands: string[];
  /** The number of data connections that are open now */
  openDataConnections(): number;
  /** The number of control connections that are open now */
  openControlConnections(): number;
  close(): Promise<void>;
}

function listenOnFreePort(server: net.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, HOST, () => resolve((server.address() as net.AddressInfo).port)));
}

function trackOpen(sockets: Set<net.Socket>, socket: net.Socket): void {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => undefined);
}

/** Send chunks on the data connection until it closes */
function sendForever(dataSocket: net.Socket): void {
  const timer = setInterval(() => dataSocket.write('G01 X1 Y1\n'), CHUNK_INTERVAL_MS);
  dataSocket.on('close', () => clearInterval(timer));
}

/**
 * A machine that sends an endless file. With `refuseFirstPasv`, the raw RETR of FTPClient fails,
 * and the download of basic-ftp (the fallback) gets the file.
 */
async function startEndlessMachine({ refuseFirstPasv = false } = {}): Promise<EndlessMachine> {
  const commands: string[] = [];
  const dataSockets = new Set<net.Socket>();
  const controlSockets = new Set<net.Socket>();
  let waitingDataSocket: Promise<net.Socket> | undefined;
  let acceptData: (socket: net.Socket) => void = () => undefined;

  const dataServer = net.createServer(socket => {
    trackOpen(dataSockets, socket);
    acceptData(socket);
  });
  const dataPort = await listenOnFreePort(dataServer);
  const pasvReply = `227 Entering Passive Mode (127,0,0,1,${Math.floor(dataPort / 256)},${dataPort % 256})`;

  const replyTo = async (socket: net.Socket, command: string) => {
    if (command === 'USER') socket.write('331 Password\r\n');
    else if (command === 'PASS') socket.write('230 Logged in\r\n');
    else if (command === 'EPSV') socket.write('500 Not supported\r\n');
    else if (command === 'PASV') {
      const isRefused = refuseFirstPasv && commands.filter(sent => sent === 'PASV').length === 1;
      waitingDataSocket = new Promise(resolve => { acceptData = resolve; });
      socket.write(isRefused ? '425 Cannot open data connection\r\n' : `${pasvReply}\r\n`);
    } else if (command === 'RETR') {
      socket.write('150 Opening data connection\r\n');
      sendForever(await waitingDataSocket!);
    } else socket.write('200 OK\r\n');
  };

  const controlServer = net.createServer(socket => {
    trackOpen(controlSockets, socket);
    socket.write('220 Endless machine\r\n');
    let buffered = '';
    socket.on('data', chunk => {
      buffered += chunk.toString();
      const lines = buffered.split('\r\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const command = line.split(' ')[0].toUpperCase();
        commands.push(command);
        void replyTo(socket, command);
      }
    });
  });
  const port = await listenOnFreePort(controlServer);

  return {
    port,
    commands,
    openDataConnections: () => dataSockets.size,
    openControlConnections: () => controlSockets.size,
    async close() {
      [...dataSockets, ...controlSockets].forEach(socket => socket.destroy());
      await Promise.all([controlServer, dataServer].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}

/** Resolve when the output got its first bytes */
function firstBytes(output: PassThrough): Promise<void> {
  return new Promise(resolve => output.once('data', () => resolve()));
}

/** The result of the download, or 'still running' when it does not end in STOP_LIMIT_MS */
function outcomeWithinLimit(download: Promise<void>): Promise<string> {
  return Promise.race([
    download.then(() => 'complete', (err: Error) => `failed: ${err.message}`),
    new Promise<string>(resolve => setTimeout(() => resolve('still running'), STOP_LIMIT_MS)),
  ]);
}

/** Wait until `isDone` is true. The machine sees a closed connection a short time after the client closes it. */
async function waitFor(isDone: () => boolean): Promise<void> {
  const end = Date.now() + STOP_LIMIT_MS;
  while (!isDone() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, CHUNK_INTERVAL_MS));
}

describe('FTPClient download that the user cancels', () => {
  let machine: EndlessMachine | undefined;
  let running: Promise<unknown> | undefined;

  afterEach(async () => {
    await machine?.close();
    // The machine closed its sockets, so a download that did not stop ends now
    await running?.catch(() => undefined);
    machine = undefined;
    running = undefined;
  });

  it.each([
    ['the raw RETR', false],
    ['the fallback download of basic-ftp', true],
  ])('stops %s and closes the connections to the machine', async (_name, refuseFirstPasv) => {
    machine = await startEndlessMachine({ refuseFirstPasv });
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();
    const started = firstBytes(output);

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await started;
    cancel.abort();

    expect(await outcomeWithinLimit(download)).toMatch(/^failed: FTP download error: /);
    await waitFor(() => machine!.openDataConnections() === 0 && machine!.openControlConnections() === 0);
    expect(machine.openDataConnections()).toBe(0);
    expect(machine.openControlConnections()).toBe(0);
  });

  it('does not try the fallback download after a cancel', async () => {
    machine = await startEndlessMachine();
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();
    const started = firstBytes(output);

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await started;
    cancel.abort();
    await outcomeWithinLimit(download);

    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
  });

  it('does not connect to the machine when the download was cancelled before it started', async () => {
    machine = await startEndlessMachine();
    const cancel = new AbortController();
    cancel.abort();

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', new PassThrough(), cancel.signal);

    await expect(download).rejects.toThrow('FTP download error: ');
    expect(machine.commands).toEqual([]);
  });
});
