import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { agentTypeOf, askChatter, askMTConnect, devicesOfProbe, foundMTConnectMachine, haasSerialOf, maybeFanuc } from './askMachines.js';

/** A web server on 127.0.0.1 that gives `body` on each request. Gives its port and a way to stop it. */
async function webServer(body: string, status = 200) {
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise(resolve => server.close(resolve)) };
}

/**
 * A web server that answers each request with a 302 to a second server, which gives `body`.
 * Gives the port of the first server, the request count of the second, and a way to stop both.
 */
async function redirectToServer(body: string) {
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests++;
    response.end(body);
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const server = createServer((request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}${request.url ?? '/'}` });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    targetRequests: () => targetRequests,
    close: () => Promise.all([server, target].map(each => new Promise(resolve => each.close(resolve)))),
  };
}

/**
 * A web server that sends `start` and then a body with no end, as fast as the client reads it.
 * With a Content-Length in `headers`, it sends only `start`, and then waits with the connection open.
 * It tells when the client stopped the connection.
 */
async function endlessServer(start: string, headers: Record<string, string> = {}) {
  let clientLeft = false;
  const chunk = Buffer.alloc(64 * 1024, 'a');
  const server = createServer((_request, response) => {
    response.writeHead(200, headers);
    response.write(start);
    const send = () => {
      while (!response.destroyed && response.write(chunk)) { /* until the socket buffer is full */ }
    };
    response.on('drain', send);
    response.on('close', () => { clientLeft = true; });
    if (!headers['Content-Length']) send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    clientLeft: () => clientLeft,
    close: () => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

/** A time limit much longer than the ask should take, so an ask that waits for the end of the body fails the test */
const LONG_TIMEOUT_MS = 4000;

const probe = (devices: string) => `<?xml version="1.0"?>
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:1.3"><Header/><Devices>${devices}</Devices></MTConnectDevices>`;

const okuma = '<Device id="okuma" name="OKUMA" uuid="u1"><Description manufacturer="OKUMA" model="GENOS M560-V"/></Device>';
const plain = '<Device id="d2" name="Mill2" uuid="u2"/>';

describe('haasSerialOf', () => {
  it('reads the serial number from a Q100 reply', () => {
    expect(haasSerialOf('>SERIAL NUMBER, 1234567\r\n')).toBe('1234567');
  });

  it('gives null for any other reply', () => {
    expect(haasSerialOf('>?, ?Q100\r\n')).toBeNull();
    expect(haasSerialOf('HTTP/1.1 400 Bad Request\r\n')).toBeNull();
  });
});

describe('agentTypeOf', () => {
  it('finds the agent type in the maker name', () => {
    expect(agentTypeOf('DMG MORI')).toBe('dmg_mori');
    expect(agentTypeOf('Okuma Corporation')).toBe('okuma');
    expect(agentTypeOf('Acme')).toBe('generic');
    expect(agentTypeOf(undefined)).toBe('generic');
  });
});

describe('devicesOfProbe', () => {
  it('lists each device with its maker and model', async () => {
    expect(await devicesOfProbe(probe(okuma + plain))).toEqual([
      { id: 'okuma', name: 'OKUMA', manufacturer: 'OKUMA', model: 'GENOS M560-V' },
      { id: 'd2', name: 'Mill2', manufacturer: undefined, model: undefined },
    ]);
  });

  it('reads tags with a namespace prefix', async () => {
    const xml = '<m:MTConnectDevices xmlns:m="urn:x"><m:Devices><m:Device id="a" name="A"/></m:Devices></m:MTConnectDevices>';
    expect((await devicesOfProbe(xml)).map(device => device.id)).toEqual(['a']);
  });
});

describe('foundMTConnectMachine', () => {
  it('names the machine by maker and model, and needs no device ID for one device', async () => {
    const found = foundMTConnectMachine('10.0.0.5', 5001, await devicesOfProbe(probe(okuma)));
    expect(found?.machine).toEqual({ type: 'mtconnect', name: 'OKUMA GENOS M560-V', host: '10.0.0.5', mtConnectPort: 5001, agentType: 'okuma' });
  });

  it('takes the first device and its ID when the agent has more than one', async () => {
    const found = foundMTConnectMachine('10.0.0.5', 5000, await devicesOfProbe(probe(okuma + plain)));
    expect(found?.machine.mtConnectDeviceId).toBe('okuma');
    expect(found?.detail).toContain('2 machines');
  });

  it('gives null when the agent has no device', () => {
    expect(foundMTConnectMachine('10.0.0.5', 5000, [])).toBeNull();
  });
});

describe('askMTConnect', () => {
  it('finds the agent by its /probe page', async () => {
    const server = await webServer(probe(okuma));
    try {
      expect((await askMTConnect('127.0.0.1', server.port))?.machine).toMatchObject({ name: 'OKUMA GENOS M560-V', mtConnectPort: server.port });
    } finally {
      await server.close();
    }
  });

  it('does not follow a redirect to another address', async () => {
    const server = await redirectToServer(probe(okuma));
    try {
      expect(await askMTConnect('127.0.0.1', server.port)).toBeNull();
      expect(server.targetRequests()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('stops reading an endless reply after 1 MB, and does not wait for its end', async () => {
    const server = await endlessServer('<?xml version="1.0"?><MTConnectDevices><!--');
    try {
      const startedAt = Date.now();
      expect(await askMTConnect('127.0.0.1', server.port, LONG_TIMEOUT_MS)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await vi.waitFor(() => expect(server.clientLeft()).toBe(true));
    } finally {
      await server.close();
    }
  });

  it('does not read a reply that says that it is longer than 1 MB', async () => {
    const server = await endlessServer('<?xml version="1.0"?><MTConnectDevices>', { 'Content-Length': String(5 * 1024 * 1024) });
    try {
      const startedAt = Date.now();
      expect(await askMTConnect('127.0.0.1', server.port, LONG_TIMEOUT_MS)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await vi.waitFor(() => expect(server.clientLeft()).toBe(true));
    } finally {
      await server.close();
    }
  });
});

describe('maybeFanuc', () => {
  it('is not confirmed, because Chatter cannot ask without the FOCAS library', () => {
    expect(maybeFanuc('10.0.0.7')).toMatchObject({ isConfirmed: false, machine: { type: 'fanuc', focasPort: 8193 } });
  });
});

describe('askChatter', () => {
  it('finds another Chatter by its /api/health, with its version and instance name', async () => {
    const server = await webServer('{"status":"ok","uptime":12,"version":"1.2.0","instance":"0123456789abcdef"}');
    try {
      expect(await askChatter('127.0.0.1', server.port)).toEqual({ host: '127.0.0.1', version: '1.2.0', instance: '0123456789abcdef' });
    } finally {
      await server.close();
    }
  });

  it('shows "unknown" for a version that does not have the shape of a version', async () => {
    const server = await webServer('{"status":"ok","version":"<b>hi</b>"}');
    try {
      expect(await askChatter('127.0.0.1', server.port)).toEqual({ host: '127.0.0.1', version: 'unknown' });
    } finally {
      await server.close();
    }
  });

  it('gives null for a web server that is not Chatter', async () => {
    for (const [body, status] of [['<html>router</html>', 200], ['{"status":"ok"}', 404], [`{"status":"ok","x":"${'a'.repeat(2000)}"}`, 200]] as const) {
      const server = await webServer(body, status);
      try {
        expect(await askChatter('127.0.0.1', server.port), body.slice(0, 20)).toBeNull();
      } finally {
        await server.close();
      }
    }
  });

  it('does not follow a redirect to another address', async () => {
    const server = await redirectToServer('{"status":"ok","version":"1.2.0"}');
    try {
      expect(await askChatter('127.0.0.1', server.port)).toBeNull();
      expect(server.targetRequests()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('stops reading an endless reply after 1 KB, and does not wait for its end', async () => {
    const server = await endlessServer('{"status":"ok","x":"');
    try {
      const startedAt = Date.now();
      expect(await askChatter('127.0.0.1', server.port, LONG_TIMEOUT_MS)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await vi.waitFor(() => expect(server.clientLeft()).toBe(true));
    } finally {
      await server.close();
    }
  });

  it('does not read a reply that says that it is longer than 1 KB', async () => {
    const server = await endlessServer('{"status":"ok"}', { 'Content-Length': '5000000' });
    try {
      const startedAt = Date.now();
      expect(await askChatter('127.0.0.1', server.port, LONG_TIMEOUT_MS)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await vi.waitFor(() => expect(server.clientLeft()).toBe(true));
    } finally {
      await server.close();
    }
  });
});
