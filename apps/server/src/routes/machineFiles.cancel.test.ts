import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { LoggedInEnv } from '../auth/authRoutes.js';
import { FTPClient } from '../ftp/FTPClient.js';
import { HOST, startEndlessMachine, waitFor, type EndlessMachine } from '../ftp/testSupport.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import type { HardwarePoller } from '../polling/poller.js';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { startWebServer } from '../webServerOptions.js';
import { machineFileRoutes } from './machineFiles.js';

// The whole path of a cancel: the browser closes the connection, @hono/node-server cancels the reply,
// streamWithoutErrorText cancels the download stream, and the FTP client stops the transfer on the machine.

/** The program routes, with one machine that downloads over a real FTP client, and a user that can read files */
function appFor(machine: EndlessMachine) {
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

describe('a program download that the browser cancels', () => {
  let machine: EndlessMachine | undefined;
  let server: Server | undefined;
  let browser: Socket | undefined;
  let log: CapturedLog | undefined;

  afterEach(async () => {
    log?.restore();
    browser?.destroy();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server!.close(err => (err ? reject(err) : resolve())));
    await machine?.close();
    log = undefined;
    browser = undefined;
    server = undefined;
    machine = undefined;
  });

  it('closes the data and control connections to the machine, and logs no error', async () => {
    log = captureLog();
    machine = await startEndlessMachine();
    server = startWebServer(appFor(machine), 0, { hostname: '127.0.0.1' });
    await once(server, 'listening');

    browser = connect((server.address() as AddressInfo).port, '127.0.0.1');
    browser.on('error', () => {});
    await once(browser, 'connect');
    browser.write('GET /machine/1/files/download?path=O1000 HTTP/1.1\r\nHost: localhost\r\n\r\n');
    let reply = '';
    await new Promise<void>(resolve => browser!.on('data', chunk => {
      reply += chunk.toString();
      if (reply.includes('G01 X1 Y1')) resolve();
    }));
    expect(machine.openDataConnections()).toBe(1);

    // The browser cancels the download
    browser.destroy();
    await waitFor(() => machine!.openDataConnections() === 0 && machine!.openControlConnections() === 0);

    expect(machine.openDataConnections()).toBe(0);
    expect(machine.openControlConnections()).toBe(0);
    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
    expect(log.lines.filter(line => line.level === 'error')).toEqual([]);
  });
});
