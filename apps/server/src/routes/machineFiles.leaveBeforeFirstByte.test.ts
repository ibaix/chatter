import { once } from 'node:events';
import type { Server } from 'node:http';
import net, { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { LoggedInEnv } from '../auth/authRoutes.js';
import { FTPClient } from '../ftp/FTPClient.js';
import { HOST, waitFor } from '../ftp/testSupport.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import type { HardwarePoller } from '../polling/poller.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { startWebServer } from '../webServerOptions.js';
import { machineFileRoutes } from './machineFiles.js';

// The browser leaves while the route still waits for the first bytes of the machine. Then the reply has no stream
// yet, so no stream cancel can stop the download. The signal of the request must stop it.

/** A machine that opens the data connection for RETR, and then sends nothing */
interface SilentMachine {
  port: number;
  commands: string[];
  dataSockets: Set<Socket>;
  controlSockets: Set<Socket>;
  close(): Promise<void>;
}

function listen(server: net.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, HOST, () => resolve((server.address() as AddressInfo).port)));
}

function keep(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => undefined);
}

async function startSilentMachine(): Promise<SilentMachine> {
  const commands: string[] = [];
  const dataSockets = new Set<Socket>();
  const controlSockets = new Set<Socket>();
  const dataServer = net.createServer(socket => keep(dataSockets, socket));
  const dataPort = await listen(dataServer);
  const replies: Record<string, string> = {
    USER: '331 Password',
    PASS: '230 Logged in',
    EPSV: '500 Not supported',
    PASV: `227 Entering Passive Mode (127,0,0,1,${Math.floor(dataPort / 256)},${dataPort % 256})`,
    RETR: '150 Opening data connection',
  };
  const controlServer = net.createServer(socket => {
    keep(controlSockets, socket);
    socket.write('220 Silent machine\r\n');
    socket.on('data', chunk => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        const command = line.split(' ')[0].toUpperCase();
        commands.push(command);
        socket.write(`${replies[command] ?? '200 OK'}\r\n`);
      }
    });
  });
  const port = await listen(controlServer);
  return {
    port,
    commands,
    dataSockets,
    controlSockets,
    async close() {
      [...dataSockets, ...controlSockets].forEach(socket => socket.destroy());
      await Promise.all([controlServer, dataServer].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}

/** The program routes, with one machine that downloads over a real FTP client, and a user that can read files */
function appFor(machine: SilentMachine) {
  const ftp = new FTPClient({ host: HOST, port: machine.port });
  const connector = {
    downloadFile: (path: string, output, signal) => ftp.downloadFile(path, output, signal),
  } as Pick<BaseMachineConnector, 'downloadFile'> as BaseMachineConnector;
  const poller = { getConnector: () => connector } as unknown as HardwarePoller;
  return new Hono<LoggedInEnv>()
    .use(async (c, next) => {
      c.set('user', { id: 1, username: 'operator', role: 'operator' });
      await next();
    })
    .route('/', machineFileRoutes(poller));
}

describe('a program download that the browser leaves before the first byte', () => {
  let machine: SilentMachine;
  let server: Server;
  let browser: Socket | undefined;
  let log: CapturedLog;

  afterEach(async () => {
    log.restore();
    browser?.destroy();
    server.closeAllConnections();
    server.close();
    await machine.close();
  });

  it('closes the data and control connections to the machine, and logs no error', async () => {
    log = captureLog();
    machine = await startSilentMachine();
    server = startWebServer(appFor(machine), 0);
    await once(server, 'listening');

    browser = connect((server.address() as AddressInfo).port, '127.0.0.1');
    browser.on('error', () => {});
    await once(browser, 'connect');
    browser.write('GET /machine/1/files/download?path=O1000 HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await waitFor(() => machine.dataSockets.size === 1 && machine.commands.includes('RETR'));
    expect(machine.dataSockets.size).toBe(1);

    // The browser leaves. The machine has sent no byte of the file.
    browser.destroy();
    await waitFor(() => machine.dataSockets.size === 0 && machine.controlSockets.size === 0);

    expect(machine.dataSockets.size).toBe(0);
    expect(machine.controlSockets.size).toBe(0);
    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(log.lines.filter(line => line.level === 'error')).toEqual([]);
  });
});
