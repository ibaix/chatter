import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_MTCONNECT_CURRENT_BYTES, MAX_MTCONNECT_PROBE_BYTES, MTConnectConnector } from './MTConnectConnector.js';
import type { MTConnectMachineConfig } from '../../types/index.js';
import { captureLog } from '../../logging/testSupport.js';
import { sendForever } from '../testSupport.js';

function newConnector(config: Partial<MTConnectMachineConfig> = {}): MTConnectConnector {
  return new MTConnectConnector({ name: 'Test', host: '192.168.1.100', ...config });
}

/** Make the connector get these replies instead of calling a real agent, and give the spy */
function serveReplies(reply: (url: string) => string) {
  return vi.spyOn(MTConnectConnector.prototype as unknown as { httpGet: (url: string, maxBytes: number) => Promise<string> }, 'httpGet')
    .mockImplementation(async (url: string) => reply(url));
}

const PROBE = `<MTConnectDevices><Devices><Device id="d1" name="M1" uuid="u1"><DataItems>
  <DataItem id="mode" type="CONTROLLER_MODE" category="EVENT"/>
</DataItems></Device></Devices></MTConnectDevices>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MTConnectConnector', () => {
  let connector: MTConnectConnector;

  beforeEach(() => {
    connector = newConnector({ id: 'test_mtconnect', name: 'TestMTConnect', mtConnectPort: 5000, timeout: 5000 });
  });

  afterEach(() => {
    connector.disconnect();
  });

  describe('constructor', () => {
    it('should initialize with provided values', () => {
      expect(connector.id).toBe('test_mtconnect');
      expect(connector.name).toBe('TestMTConnect');
      expect(connector.host).toBe('192.168.1.100');
      expect(connector.mtConnectPort).toBe(5000);
      expect(connector.connected).toBe(false);
      expect(connector.type).toBe('mtconnect');
    });

    it('should use default port when not provided', () => {
      expect(newConnector().mtConnectPort).toBe(5000);
    });

    it('should generate id from timestamp if not provided', () => {
      // ID is generated with "machine_" prefix from base class
      expect(newConnector().id).toMatch(/^machine_\d+$/);
    });

    it('should accept optional deviceId filter', () => {
      expect(newConnector({ mtConnectDeviceId: 'device123' }).mtConnectDeviceId).toBe('device123');
    });

    it('should accept optional agentType', () => {
      expect(newConnector({ agentType: 'okuma' }).agentType).toBe('okuma');
    });

    it('uses the FTP defaults when none are set', () => {
      expect(newConnector().getStatus()).toMatchObject({ ftpPort: 21, ftpUser: 'anonymous', hasFtpPassword: false });
    });
  });

  describe('disconnect', () => {
    it('should set connected to false', () => {
      connector.connected = true;
      connector.disconnect();

      expect(connector.connected).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      connector.disconnect();
      connector.disconnect();
      expect(connector.connected).toBe(false);
    });
  });

  describe('checkConnection', () => {
    it('should return false when not connected', () => {
      expect(connector.checkConnection()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return current status object', () => {
      const status = connector.getStatus();

      expect(status.id).toBe('test_mtconnect');
      expect(status.name).toBe('TestMTConnect');
      expect(status.host).toBe('192.168.1.100');
      expect(status.mtConnectPort).toBe(5000);
      expect(status.type).toBe('mtconnect');
      expect(status.connected).toBe(false);
      expect(status.errors).toEqual([]);
      expect(status.data).toBeDefined();
    });

    it('should include lastPollTime as null when not polled', () => {
      expect(connector.getStatus().lastPollTime).toBeNull();
    });

    it('should include macros when configured', () => {
      const macroConnector = newConnector({
        macros: [
          { location: 100, name: 'Variable 100' },
          { location: 200 }
        ]
      });

      const status = macroConnector.getStatus();
      expect(status.macros).toHaveLength(2);
      expect(status.macros![0].location).toBe(100);
      expect(status.macros![0].name).toBe('Variable 100');
      expect(status.macros![1].location).toBe(200);
      expect(status.macros![1].name).toBeUndefined();
    });
  });

  describe('updateMacros', () => {
    it('should update macros configuration', () => {
      connector.updateMacros([{ location: 500, name: 'New Macro' }]);

      const status = connector.getStatus();
      expect(status.macros).toHaveLength(1);
      expect(status.macros![0].location).toBe(500);
      expect(status.macros![0].name).toBe('New Macro');
    });
  });
});

describe('MTConnect agent URLs', () => {
  it('probes the agent on its host and port, then asks for the current values of the found items', async () => {
    const httpGet = serveReplies(url => (url.includes('/probe') ? PROBE : '<MTConnectStreams/>'));

    await newConnector({ mtConnectPort: 5001 }).poll();

    expect(httpGet).toHaveBeenNthCalledWith(1, 'http://192.168.1.100:5001/probe', MAX_MTCONNECT_PROBE_BYTES);
    expect(httpGet).toHaveBeenNthCalledWith(2, expect.any(String), MAX_MTCONNECT_CURRENT_BYTES);
    const currentUrl = new URL(httpGet.mock.calls[1][0]);
    expect(currentUrl.pathname).toBe('/current');
    expect(currentUrl.searchParams.get('path')).toBe('//DataItem[@category="CONDITION" or @id="mode"]');
  });
});

describe('MTConnect probe errors', () => {
  async function connectWithProbe(probe: string, config: Partial<MTConnectMachineConfig> = {}) {
    serveReplies(() => probe);
    const connector = newConnector(config);
    await connector.connect();
    return connector;
  }

  it('is not connected when the probe has no MTConnectDevices root', async () => {
    const connector = await connectWithProbe('<Other/>');

    expect(connector.connected).toBe(false);
    expect(connector.getStatus().errors).toEqual(['Connection failed: Invalid probe response: missing MTConnectDevices']);
  });

  it('is not connected when the probe has none of the data items that Chatter reads', async () => {
    const connector = await connectWithProbe('<MTConnectDevices><Devices><Device id="d1"/></Devices></MTConnectDevices>');

    expect(connector.getStatus().errors).toEqual(['Connection failed: No matching data items found in probe response']);
  });

  it('is not connected when the configured device is not in the probe', async () => {
    const connector = await connectWithProbe(PROBE, { mtConnectDeviceId: 'nonexistent' });

    expect(connector.getStatus().errors).toEqual(["Connection failed: Device with id 'nonexistent' not found"]);
  });

  it('connects to the configured device', async () => {
    const connector = await connectWithProbe(PROBE, { mtConnectDeviceId: 'd1' });

    expect(connector.connected).toBe(true);
    expect(connector.checkConnection()).toBe(true);
  });
});

describe('MTConnect HTTP errors', () => {
  it('reports the HTTP status when the agent does not answer OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }));
    const connector = newConnector();

    await connector.connect();

    expect(connector.getStatus().errors).toEqual(['Connection failed: HTTP 404: Not Found']);
  });

  it('reports a timeout when the agent does not answer in time', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    const connector = newConnector({ timeout: 5000 });

    await connector.connect();

    expect(connector.getStatus().errors).toEqual(['Connection failed: Request timeout after 5000ms']);
  });
});

/** A web server on 127.0.0.1 that answers each request with `answer`. Gives its port, its request count and a way to stop it. */
async function localServer(answer: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    answer(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

describe('MTConnect redirects', () => {
  /** Connect to an agent that answers with `status` and a Location of a second server. Gives the result and the request counts. */
  async function connectToAgentThatSends(status: number) {
    const target = await localServer(response => response.end(PROBE));
    const agent = await localServer(response => {
      response.writeHead(status, { Location: `http://127.0.0.1:${target.port}/probe` });
      response.end();
    });
    const connector = newConnector({ host: '127.0.0.1', mtConnectPort: agent.port });
    try {
      await connector.connect();
      return {
        connected: connector.connected,
        errors: connector.getStatus().errors,
        agentRequests: agent.requests(),
        targetRequests: target.requests(),
      };
    } finally {
      await Promise.all([agent.close(), target.close()]);
    }
  }

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %i redirect from the agent to another address, and says why it did not connect',
    async status => {
      const result = await connectToAgentThatSends(status);

      expect(result.agentRequests).toBe(1);
      expect(result.targetRequests).toBe(0);
      expect(result.connected).toBe(false);
      expect(result.errors).toEqual([
        `Connection failed: The agent sent a redirect (HTTP ${status}). Chatter does not follow redirects. Set the address and port of the agent itself.`,
      ]);
    },
  );

  it('treats a 304 Not Modified as a redirect, and does not connect', async () => {
    const result = await connectToAgentThatSends(304);

    expect(result.agentRequests).toBe(1);
    expect(result.targetRequests).toBe(0);
    expect(result.connected).toBe(false);
    expect(result.errors).toEqual([
      'Connection failed: The agent sent a redirect (HTTP 304). Chatter does not follow redirects. Set the address and port of the agent itself.',
    ]);
  });

  it('still gives the normal HTTP error for a 400, which is not a redirect', async () => {
    const result = await connectToAgentThatSends(400);

    expect(result.targetRequests).toBe(0);
    expect(result.connected).toBe(false);
    expect(result.errors).toEqual(['Connection failed: HTTP 400: Bad Request']);
  });

  it('keeps the redirect error when the agent closes the connection before the end of the body', async () => {
    // A real socket cannot fix the order of the close and the cancel. A body stream with an error
    // gives the same state each time: the agent sent the 302 headers, and then the body broke.
    const brokenBody = new ReadableStream({ start: controller => controller.error(new TypeError('terminated')) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(brokenBody, { status: 302, headers: { Location: 'http://127.0.0.1:1/probe' } }),
    );
    const connector = newConnector({ host: '127.0.0.1', mtConnectPort: 5000 });

    await connector.connect();

    expect(connector.connected).toBe(false);
    expect(connector.getStatus().errors).toEqual([
      'Connection failed: The agent sent a redirect (HTTP 302). Chatter does not follow redirects. Set the address and port of the agent itself.',
    ]);
  });

  it('does not find an agent on a port that sends a redirect, and does not follow it', async () => {
    const target = await localServer(response => response.end(PROBE));
    const agent = await localServer(response => {
      response.writeHead(302, { Location: `http://127.0.0.1:${target.port}/probe` });
      response.end();
    });

    try {
      expect(await MTConnectConnector.probePort('127.0.0.1', agent.port)).toBe(false);
      expect(agent.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    } finally {
      await Promise.all([agent.close(), target.close()]);
    }
  });
});

describe('MTConnect reply size limit', () => {
  const TOO_LARGE = 'Connection failed: The machine sent a reply larger than 4 MB. Chatter stopped reading it and closed the connection.';
  /** Longer than each test, so a test that waits for it fails */
  const LONG_TIMEOUT_MS = 60_000;

  /** Connect to an agent that answers with `answer`. Gives the status, the warnings in the log, and the bytes that the agent sent. */
  async function connectTo(answer: (response: ServerResponse) => Promise<number> | void, timeout = LONG_TIMEOUT_MS) {
    let sent: Promise<number> | undefined;
    const agent = await localServer(response => { sent = answer(response) || undefined; });
    const log = captureLog();
    const connector = newConnector({ id: 'dmg1', host: '127.0.0.1', mtConnectPort: agent.port, timeout });
    try {
      await connector.connect();
      return { status: connector.getStatus(), warnings: log.text('warn'), sentBytes: await sent };
    } finally {
      log.restore();
      await agent.close();
    }
  }

  it('the limits are 4 MB for /probe and 1 MB for /current, with a wide margin over the replies of real agents', () => {
    expect(MAX_MTCONNECT_PROBE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_MTCONNECT_CURRENT_BYTES).toBe(1024 * 1024);
  });

  it('stops reading an endless body at the limit, shows the machine offline with the reason, and writes one warning', async () => {
    const result = await connectTo(response => {
      response.writeHead(200, { 'Content-Type': 'text/xml' });
      return sendForever(response);
    });

    expect(result.status.connected).toBe(false);
    expect(result.status.errors).toEqual([TOO_LARGE]);
    expect(result.warnings.split('\n')).toHaveLength(1);
    expect(result.warnings).toContain('dmg1');
    expect(result.warnings).toContain(String(MAX_MTCONNECT_PROBE_BYTES));
    // The agent stops when Chatter closes the connection. Only the socket buffers hold more than the limit. On Linux,
    // the receive and send buffers can hold about 10 MB together, so the margin is wide.
    expect(result.sentBytes).toBeLessThan(MAX_MTCONNECT_PROBE_BYTES + 32 * 1024 * 1024);
  });

  it('stops at once when the Content-Length is larger than the limit, and does not wait for the body', async () => {
    const result = await connectTo(response => {
      response.writeHead(200, { 'Content-Length': String(MAX_MTCONNECT_PROBE_BYTES + 1) });
      response.write('<MTConnectDevices>');
    });

    expect(result.status.connected).toBe(false);
    expect(result.status.errors).toEqual([TOO_LARGE]);
  });

  it('still reads a normal body', async () => {
    const result = await connectTo(response => { response.end(PROBE); });

    expect(result.status.errors).toEqual([]);
    expect(result.status.connected).toBe(true);
  });

  it('still reads a body of the limit size', async () => {
    const body = PROBE + ' '.repeat(MAX_MTCONNECT_PROBE_BYTES - PROBE.length);

    const result = await connectTo(response => { response.end(body); });

    expect(result.status.connected).toBe(true);
  });

  it('stops a /current reply larger than its smaller limit, and probes the agent again at the next poll', async () => {
    const current = '<MTConnectStreams><Streams/></MTConnectStreams>';
    let currentReply = current + ' '.repeat(MAX_MTCONNECT_CURRENT_BYTES + 1 - current.length);
    let probes = 0;
    const agent = createServer((request, response) => {
      if (request.url?.startsWith('/probe')) {
        probes++;
        response.end(PROBE);
      } else {
        response.end(currentReply);
      }
    });
    await new Promise<void>(resolve => agent.listen(0, '127.0.0.1', resolve));
    const connector = newConnector({ host: '127.0.0.1', mtConnectPort: (agent.address() as AddressInfo).port });
    const log = captureLog();
    try {
      const status = await connector.poll();
      expect(status.errors).toEqual([
        'Poll failed: The machine sent a reply larger than 1 MB. Chatter stopped reading it and closed the connection.',
      ]);
      expect(log.text('warn')).toContain(String(MAX_MTCONNECT_CURRENT_BYTES));

      currentReply = current + ' '.repeat(MAX_MTCONNECT_CURRENT_BYTES - current.length);
      expect((await connector.poll()).errors).toEqual([]);
      expect(probes).toBe(2);
    } finally {
      log.restore();
      await new Promise(resolve => { agent.close(resolve); agent.closeAllConnections(); });
    }
  });

  it('gives the timeout error when the body stops before its end', async () => {
    const result = await connectTo(response => {
      response.writeHead(200, { 'Content-Type': 'text/xml' });
      response.write('<MTConnectDevices>');
    }, 200);

    expect(result.status.errors).toEqual(['Connection failed: Request timeout after 200ms']);
  });
});

describe('MTConnect port scan', () => {
  it('tries the MTConnect agent default port first', () => {
    expect(MTConnectConnector.COMMON_PORTS[0]).toBe(5000);
    expect(MTConnectConnector.COMMON_PORTS).toContain(5001);
    expect(MTConnectConnector.COMMON_PORTS).toContain(7878);
  });

  it('includes HTTP ports for web-based agents', () => {
    expect(MTConnectConnector.COMMON_PORTS).toContain(80);
    expect(MTConnectConnector.COMMON_PORTS).toContain(8080);
    expect(MTConnectConnector.COMMON_PORTS).toContain(8081);
  });

  it('finds the ports where an MTConnect agent answers the probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const port = new URL(String(input)).port;
      return new Response(port === '5001' || port === '8080' ? '<MTConnectDevices/>' : '<html/>');
    });

    expect(await MTConnectConnector.scanAllPorts('192.168.1.100')).toEqual([5001, 8080]);
    expect(await MTConnectConnector.scanForPort('192.168.1.100')).toBe(5001);
  });
});
