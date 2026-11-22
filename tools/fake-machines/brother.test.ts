import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { startBrotherServer } from './brother.js';
import { HIGH_SPEED_PROGRAMS } from './programs.js';
import { MachineSimulator } from './simulator.js';
import { slowStartOf } from './tcp.js';

let server: net.Server | null = null;

afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())));

async function startServer(): Promise<number> {
  const simulator = new MachineSimulator({ programs: HIGH_SPEED_PROGRAMS, alarms: [], speed: 1 });
  server = startBrotherServer(simulator, '127.0.0.1', 0, slowStartOf(0));
  await new Promise(resolve => server!.once('listening', resolve));
  return (server!.address() as net.AddressInfo).port;
}

/** Send one LOD request, and give the reply between the % signs */
function ask(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`%CLOD    ${command.padEnd(8)}  \r\n\r\n00%`));
    let reply = '';
    socket.on('data', chunk => {
      reply += chunk.toString('ascii');
      const frame = /%([^%]*)%/.exec(reply);
      if (frame) {
        socket.destroy();
        resolve(frame[1]);
      }
    });
    socket.on('error', reject);
  });
}

describe('the fake Brother', () => {
  it('answers a command that it knows with status 00', async () => {
    const port = await startServer();

    expect(await ask(port, 'PANEL')).toMatch(/^RLOD {4}PANEL {3}00\r\nD01,/);
  });

  it('answers a command that it does not know with status 08, as a real control does', async () => {
    const port = await startServer();

    const reply = await ask(port, 'NOSUCH');

    expect(reply).toMatch(/^RLOD {4}NOSUCH {2}08\r\n/);
    expect(reply).not.toMatch(/^[A-Z]\d{2},/m);
  });
});
