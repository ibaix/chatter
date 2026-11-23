import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import {
  HaasConnector,
  MAX_HAAS_LINE_BYTES,
  MAX_HAAS_QUERY_REPLY_BYTES,
  buildCommandString,
  haasAlarmText,
  openSocket,
  parseQueryResponse,
  parseRunStatus,
} from './HaasConnector.js';
import type { HaasMachineConfig, HaasMachineStatus } from '../../types/index.js';
import { captureLog, type CapturedLog } from '../../logging/testSupport.js';
import { sendForever } from '../testSupport.js';

/** Port 1 has no server, so a connection to it fails at once */
const CLOSED_PORT = 1;

describe('HaasConnector', () => {
  let connector: HaasConnector;

  beforeEach(() => {
    connector = new HaasConnector({
      id: 'test_haas',
      name: 'FakeHaas',
      host: '127.0.0.1',
      dataPort: 9998,
      queryPort: 5051,
      timeout: 5000
    });
  });

  afterEach(() => {
    connector.disconnect();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided values', () => {
      expect(connector.id).toBe('test_haas');
      expect(connector.name).toBe('FakeHaas');
      expect(connector.host).toBe('127.0.0.1');
      expect(connector.dataPort).toBe(9998);
      expect(connector.queryPort).toBe(5051);
      expect(connector.connected).toBe(false);
      expect(connector.type).toBe('haas');
    });

    it('should use default ports when not provided', () => {
      const defaultConnector = new HaasConnector({ name: 'DefaultHaas', host: '192.168.1.100' });

      expect(defaultConnector.dataPort).toBe(9998);
      expect(defaultConnector.queryPort).toBe(5051);
    });

    it('should generate id from timestamp if not provided', () => {
      const autoIdConnector = new HaasConnector({ name: 'AutoIdHaas', host: '192.168.1.100' });

      expect(autoIdConnector.id).toMatch(/^haas_\d+$/);
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

      expect(status.id).toBe('test_haas');
      expect(status.name).toBe('FakeHaas');
      expect(status.host).toBe('127.0.0.1');
      expect(status.dataPort).toBe(9998);
      expect(status.queryPort).toBe(5051);
      expect(status.type).toBe('haas');
      expect(status.connected).toBe(false);
      expect(status.errors).toEqual([]);
      expect(status.data).toBeDefined();
    });

    it('should have no lastPollTime before the first poll', () => {
      expect(connector.getStatus().lastPollTime).toBeNull();
    });
  });
});

describe('Haas query commands', () => {
  it('asks for a macro with its location', () => {
    expect(buildCommandString({ queryStart: 'Q600', macroLocation: 100, label: 'macro_100' })).toBe('?Q600 100\n');
  });

  it('asks for the mode with only the Q code', () => {
    expect(buildCommandString({ queryStart: 'Q104', label: 'mode' })).toBe('?Q104\n');
  });
});

describe('Haas query response parsing', () => {
  it('reads the value after the first comma', () => {
    expect(parseQueryResponse('>M30 #1, 380\r\n', false)).toBe('380');
    expect(parseQueryResponse('>MODE, MEM\r\n', false)).toBe('MEM');
  });

  it('reads a macro value only from a MACRO reply', () => {
    expect(parseQueryResponse('>MACRO, 12.500000\r\n', true)).toBe('12.500000');
    expect(parseQueryResponse('>MODE, MEM\r\n', true)).toBeNull();
  });

  it('ignores the reply to an unknown command', () => {
    expect(parseQueryResponse('>?, ?Q105\r\n', false)).toBeNull();
  });
});

describe('Q500 run status, in MTConnect execution words', () => {
  it('gives ACTIVE while a program runs, when the control answers only "STATUS, BUSY"', () => {
    expect(parseRunStatus('>STATUS, BUSY\r\n')).toBe('ACTIVE');
  });

  it('reads the status after the program name when no program runs', () => {
    expect(parseRunStatus('>PROGRAM, O01234, IDLE, PARTS, 380\r\n')).toBe('READY');
    expect(parseRunStatus('>PROGRAM, O01234, FEED HOLD, PARTS, 380\r\n')).toBe('FEED_HOLD');
    expect(parseRunStatus('>PROGRAM, O01234, ALARM ON, PARTS, 380\r\n')).toBe('STOPPED');
  });

  it('reads the reply of an older control, which has STX and ETB bytes around it', () => {
    expect(parseRunStatus('\x02STATUS, BUSY\x17\r\n')).toBe('ACTIVE');
  });

  it('gives null for a status or a reply that it does not know', () => {
    expect(parseRunStatus('>PROGRAM, O01234, SOMETHING, PARTS, 3\r\n')).toBeNull();
    expect(parseRunStatus('>?, ?Q500\r\n')).toBeNull();
  });
});

describe('Haas alarm codes', () => {
  it.each([
    ['107', 'EMERGENCY STOP'],
    ['108', 'X SERVO OVERLOAD'],
    ['109', 'Y SERVO OVERLOAD'],
    ['110', 'Z SERVO OVERLOAD'],
    ['111', 'A SERVO OVERLOAD'],
    ['188', 'B SERVO OVERLOAD'],
    ['271', 'C SERVO OVERLOAD'],
    ['674', 'TT SERVO OVERLOAD'],
    ['1.108', 'X AXIS SERVO OVERLOAD'],
    ['2.108', 'Y AXIS SERVO OVERLOAD'],
    ['3.108', 'Z AXIS SERVO OVERLOAD'],
    ['5.108', 'A AXIS SERVO OVERLOAD'],
    ['6.108', 'B AXIS SERVO OVERLOAD'],
    ['7.108', 'C AXIS SERVO OVERLOAD'],
    ['11.108', 'TA AXIS SERVO OVERLOAD'],
  ])('maps alarm code %s to "%s"', (code, text) => {
    expect(haasAlarmText(code)).toBe(text);
  });

  it('gives no text for an unknown code', () => {
    expect(haasAlarmText('999')).toBeUndefined();
    expect(haasAlarmText('0')).toBeUndefined();
  });
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

function close(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/**
 * A small TCP server that answers Q commands the way the Haas NGC manual shows
 * ("27 - NGC - Machine Data Collection").
 */
function startFakeQueryPort(replies: Record<string, string>): Promise<net.Server> {
  const server = net.createServer(socket => answerQueries(socket, replies));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Answer each Q command on this socket with its reply, or with "?" for an unknown command */
function answerQueries(socket: net.Socket, replies: Record<string, string>): void {
  socket.on('data', chunk => {
    for (const query of chunk.toString('ascii').split('\n').filter(Boolean)) {
      const reply = replies[query.trim()] ?? `?, ${query.trim()}`;
      socket.write(`>${reply}\r\n`);
    }
  });
}

/** A connector that reads only the query port of this fake server */
function queryPortConnector(server: net.Server, config: Partial<HaasMachineConfig> = {}): HaasConnector {
  const queryPort = (server.address() as net.AddressInfo).port;
  return new HaasConnector({ name: 'NGC', host: '127.0.0.1', dataPort: CLOSED_PORT, queryPort, ...config });
}

describe('Haas part count from a real-shaped query port', () => {
  let server: net.Server;
  let connector: HaasConnector;

  beforeEach(async () => {
    server = await startFakeQueryPort({
      '?Q104': 'MODE, MEM',
      '?Q402': 'M30 #1, 380',
      '?Q500': 'PROGRAM, O01234, IDLE, PARTS, 380',
      '?Q600 1098': 'MACRO, 37.000000',
      '?Q600 100': 'MACRO, 12.500000',
      '?Q301': 'C.S. TIME, 00098:18:29',
    });
    connector = queryPortConnector(server);
  });

  afterEach(async () => {
    connector.disconnect();
    await close(server);
  });

  it('reads the part count from the M30 counter', async () => {
    const status = await connector.poll();

    expect(status.data.partCount).toBe(380);
    expect(status.data.mode).toBe('MEM');
  });

  it('does not take the motion time as the part goal', async () => {
    const status = await connector.poll();

    expect(status.data.partGoal).toBeUndefined();
  });

  it('tells if a program runs, from Q500, so the history can record the running time', async () => {
    const status = await connector.poll();

    expect(status.data.execution).toBe('READY');
    expect(connector.getDataSnapshot().execution).toBe('READY');
  });

  it('reads the spindle load in percent from macro #1098', async () => {
    const status = await connector.poll();

    expect(status.data.spindleLoad).toBe(37);
    expect(connector.getDataSnapshot().spindleLoad).toBe(37);
  });

  it('reads each configured macro under its name, and gives it in the snapshot', async () => {
    connector.updateMacros([{ location: 100, name: 'Cycle Time' }]);

    const status = await connector.poll();

    expect(status.data['Cycle Time']).toBe(12.5);
    expect(connector.getDataSnapshot().custom).toEqual({ 'Cycle Time': 12.5 });
  });
});

describe('Haas live values when the control stops giving them', () => {
  async function withConnector(replies: Record<string, string>, test: (connector: HaasConnector) => Promise<void>) {
    const server = await startFakeQueryPort(replies);
    const connector = queryPortConnector(server);
    try {
      await test(connector);
    } finally {
      connector.disconnect();
      await close(server);
    }
  }

  it('forgets the old run status, so a machine that ran does not show "running" for ever', async () => {
    const replies: Record<string, string> = { '?Q500': 'STATUS, BUSY' };
    await withConnector(replies, async connector => {
      expect((await connector.poll()).data.execution).toBe('ACTIVE');

      replies['?Q500'] = 'STATUS, SOMETHING NEW';
      expect((await connector.poll()).data.execution).toBeUndefined();
    });
  });

  it('shows an alarm when Q500 says ALARM ON, also with no alarm value from the data stream', async () => {
    const replies: Record<string, string> = { '?Q500': 'PROGRAM, O01234, ALARM ON, PARTS, 380' };
    await withConnector(replies, async connector => {
      await connector.poll();
      expect(connector.getDataSnapshot()).toMatchObject({ alarm: true, execution: 'STOPPED' });

      replies['?Q500'] = 'PROGRAM, O01234, IDLE, PARTS, 380';
      await connector.poll();
      expect(connector.getDataSnapshot().alarm).toBeUndefined();
    });
  });

  it('forgets the old spindle load when the control gives no load', async () => {
    const replies: Record<string, string> = { '?Q600 1098': 'MACRO, 55.000000' };
    await withConnector(replies, async connector => {
      expect((await connector.poll()).data.spindleLoad).toBe(55);

      delete replies['?Q600 1098'];
      expect((await connector.poll()).data.spindleLoad).toBeUndefined();
    });
  });

  it('forgets the old run status and spindle load when a query fails', async () => {
    let endless = false;
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => {
      sockets.push(socket);
      socket.on('data', chunk => {
        if (endless) {
          void sendForever(socket);
          return;
        }
        const query = chunk.toString('ascii').trim();
        socket.write(query === '?Q500' ? '>STATUS, BUSY\r\n' : query === '?Q600 1098' ? '>MACRO, 55.0\r\n' : `>?, ${query}\r\n`);
      });
    });
    const connector = queryPortConnector(await listen(server).then(() => server));
    try {
      expect((await connector.poll()).data).toMatchObject({ execution: 'ACTIVE', spindleLoad: 55 });

      endless = true;
      const status = await connector.poll();

      expect(status.errors[0]).toMatch(/^Query error:/);
      expect(status.data.execution).toBeUndefined();
      expect(status.data.spindleLoad).toBeUndefined();
    } finally {
      connector.disconnect();
      for (const socket of sockets) socket.destroy();
      await close(server);
    }
  });

  it('does not read the byte 0x8A as an end of line, so a high byte cannot end a query reply early', async () => {
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        const query = chunk.toString('ascii').trim();
        socket.write(query === '?Q104'
          ? Buffer.concat([Buffer.from('>MODE, M'), Buffer.from([0x8a]), Buffer.from('EM\r\n')])
          : `>?, ${query}\r\n`);
      });
    });
    const connector = queryPortConnector(await listen(server).then(() => server));
    try {
      expect((await connector.poll()).data.mode).toBe('M\u008aEM');
    } finally {
      connector.disconnect();
      await close(server);
    }
  });

  it('forgets the old run status when the query port is down', async () => {
    const server = await startFakeQueryPort({ '?Q500': 'STATUS, BUSY' });
    const sockets: net.Socket[] = [];
    server.on('connection', socket => sockets.push(socket));
    const connector = queryPortConnector(server);
    try {
      expect((await connector.poll()).data.execution).toBe('ACTIVE');

      for (const socket of sockets) socket.destroy();
      await close(server);
      await vi.waitFor(() => expect(connector.checkConnection()).toBe(false));

      expect((await connector.poll()).data.execution).toBeUndefined();
    } finally {
      connector.disconnect();
    }
  });
});

describe('Haas data stream', () => {
  const DELIMITER = '\n\x03\x02';
  let server: net.Server;
  let connector: HaasConnector;

  /** A fake data stream port that sends these lines after the init string */
  async function startDataStream(lines: string[]): Promise<void> {
    server = net.createServer(socket => {
      socket.once('data', () => socket.write(lines.map(line => line + DELIMITER).join('')));
    });
    const dataPort = await listen(server);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });
  }

  /** Poll until the data stream values have come */
  async function pollUntil(isReady: (data: Record<string, unknown>) => boolean) {
    return vi.waitFor(async () => {
      const status = await connector.poll();
      if (!isReady(status.data)) throw new Error('No data stream values yet');
      return status;
    });
  }

  beforeEach(() => {
  });

  afterEach(async () => {
    connector.disconnect();
    await close(server);
    vi.restoreAllMocks();
  });

  it('reads the tool, the program and the spindle speed, which Haas sends with 4 decimal places', async () => {
    await startDataStream(['ActiveTool|5|ProgramName|O1234|SpindleActualRPM|80000000']);

    const status = await pollUntil(data => data.toolNumber !== undefined);

    expect(status.data).toMatchObject({ toolNumber: 5, program: 'O1234', spindleSpeed: 8000 });
  });

  it('gives the alarm text of a known alarm code from the local table', async () => {
    await startDataStream(['alarm0|107']);

    const status = await pollUntil(data => data.alarm !== undefined);

    expect(status.data).toMatchObject({ alarm: true, alarmCode: '107', alarmText: 'EMERGENCY STOP' });
  });

  it('gives a plain alarm text for an unknown alarm code', async () => {
    await startDataStream(['alarm0|999']);

    const status = await pollUntil(data => data.alarm !== undefined);

    expect(status.data.alarmText).toBe('ALARM 999');
  });

  it('is not in alarm when the alarm code is 0', async () => {
    await startDataStream(['alarm0|0']);

    const status = await pollUntil(data => data.alarm !== undefined);

    expect(status.data).toMatchObject({ alarm: false, alarmText: undefined });
  });

  it('finds a delimiter that is split over three chunks, and reads the line after it', async () => {
    server = net.createServer(socket => {
      socket.once('data', async () => {
        for (const part of ['ActiveTool|5\n', '\x03', `\x02ProgramName|O1${DELIMITER}`]) {
          socket.write(part);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      });
    });
    const dataPort = await listen(server);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });

    const status = await pollUntil(data => data.program !== undefined);

    expect(status.data).toMatchObject({ toolNumber: 5, program: 'O1' });
  });

  it('forgets a part of a line when the data stream closes, so the first line of the next connection reads correctly', async () => {
    let connections = 0;
    server = net.createServer(socket => {
      connections++;
      const reply = connections === 1 ? 'ProgramName|O9|Active' : `ActiveTool|5${DELIMITER}`;
      socket.once('data', () => (connections === 1 ? socket.end(reply) : socket.write(reply)));
    });
    const dataPort = await listen(server);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });

    const status = await pollUntil(data => data.toolNumber !== undefined);

    expect(connections).toBe(2);
    expect(status.data.toolNumber).toBe(5);
    expect(status.data.program).toBeUndefined();
  });
});

describe('Haas openSocket socket options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns on TCP keepalive and sends each command at once', async () => {
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { return this; });
    const keepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    const noDelay = vi.spyOn(net.Socket.prototype, 'setNoDelay');
    const socket = new net.Socket();
    const opening = openSocket(socket, { host: '127.0.0.1', port: 5051, timeoutMs: 60_000, name: 'Query port', onDown: () => {} });

    socket.destroy();
    await opening.catch(() => {});

    expect(keepAlive).toHaveBeenCalledWith(true, expect.any(Number));
    expect(noDelay).toHaveBeenCalledWith(true);
  });
});

describe('Haas openSocket when the socket closes before it connects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends with an error, so a disconnect during a connect does not leave the poll waiting forever', async () => {
    // The connect never ends, as with a machine that is off behind a router
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { return this; });
    const socket = new net.Socket();
    const onDown = vi.fn();
    const opening = openSocket(socket, { host: '127.0.0.1', port: 5051, timeoutMs: 60_000, name: 'Query port', onDown });

    // What disconnect() does
    socket.destroy();

    await expect(opening).rejects.toThrow('Query port connection closed before it opened');
    expect(onDown).toHaveBeenCalledTimes(1);
  });
});

describe('Haas reply size limits', () => {
  const DELIMITER = '\n\x03\x02';
  const LINE_TOO_LARGE =
    'Data stream: The machine sent a reply larger than 1 MB. Chatter stopped reading it and closed the connection.';
  const QUERY_TOO_LARGE =
    'Query error: The machine sent a reply larger than 64 KB. Chatter stopped reading it and closed the connection.';
  /**
   * After Chatter closes the connection, the socket buffers still hold some bytes of the endless reply. On Linux the
   * receive and send buffers can hold about 10 MB together, so the margin is wide.
   */
  const SOCKET_BUFFER_MARGIN = 32 * 1024 * 1024;
  let server: net.Server;
  let connector: HaasConnector;
  let log: CapturedLog;
  /** For each endless reply, the bytes that the fake sent until the connection closed */
  let sentBytes: Promise<number>[];
  /** The side of the machine of each connection */
  let sockets: net.Socket[];

  /**
   * A fake port. On the first connection, after the first request, it sends an endless reply with no end.
   * Each later connection gets `answer`, as from a normal machine.
   */
  async function startPort(answer: (socket: net.Socket) => void = () => {}): Promise<number> {
    sentBytes = [];
    sockets = [];
    server = net.createServer(socket => {
      sockets.push(socket);
      if (sockets.length === 1) socket.once('data', () => sentBytes.push(sendForever(socket)));
      else answer(socket);
    });
    return listen(server);
  }

  /**
   * A fake port that, after the first request, sends these parts with a short wait between them.
   * It answers each later query with "?", so the other queries of a poll do not wait for their time limit.
   */
  async function startSlowPort(parts: string[]): Promise<number> {
    sentBytes = [];
    sockets = [];
    server = net.createServer(socket => {
      sockets.push(socket);
      socket.once('data', async () => {
        for (const part of parts) {
          socket.write(part);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        answerQueries(socket, {});
      });
    });
    return listen(server);
  }

  /** Poll until `isDone`. Gives the last status and the errors of all the polls. */
  async function pollUntil(isDone: (status: HaasMachineStatus) => boolean) {
    const errors: string[] = [];
    const status = await vi.waitFor(async () => {
      const next = await connector.poll();
      errors.push(...next.errors);
      if (!isDone(next)) throw new Error('Not done yet');
      return next;
    }, { timeout: 5000 });
    return { status, errors };
  }

  const dataStreamErrors = (errors: string[]) => errors.filter(error => error.startsWith('Data stream:'));

  beforeEach(() => {
    log = captureLog();
  });

  afterEach(async () => {
    log.restore();
    connector.disconnect();
    for (const socket of sockets) socket.destroy();
    await close(server);
  });

  it('closes the data stream at a line with no end, tells why once, and reads the next connection normally', async () => {
    const dataPort = await startPort(socket => socket.once('data', () => socket.write(`ActiveTool|5${DELIMITER}`)));
    connector = new HaasConnector({ id: 'vf2', name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });

    // The error can show in the first or in a later poll. That depends on when the endless reply reaches the limit.
    const { errors } = await pollUntil(status => status.data.toolNumber === 5);

    expect(await sentBytes[0]).toBeLessThan(MAX_HAAS_LINE_BYTES + SOCKET_BUFFER_MARGIN);
    expect(sockets).toHaveLength(2);
    expect(dataStreamErrors(errors)).toEqual([LINE_TOO_LARGE]);
    expect(dataStreamErrors((await connector.poll()).errors)).toEqual([]);
    expect(log.text('warn').split('\n')).toHaveLength(1);
    expect(log.text('warn')).toContain('vf2');
    expect(log.text('warn')).toContain(String(MAX_HAAS_LINE_BYTES));
  });

  it('forgets the data stream error at a disconnect, so it does not show after a change of the settings', async () => {
    const dataPort = await startPort();
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });
    await connector.connect();
    await vi.waitFor(() => expect(sentBytes).toHaveLength(1));
    await sentBytes[0];

    connector.disconnect();
    const status = await connector.poll();

    expect(sockets).toHaveLength(2);
    expect(dataStreamErrors(status.errors)).toEqual([]);
  });

  it('fails a query whose reply has no end of line at the limit, and connects the query port again at the next poll', async () => {
    const queryPort = await startPort(socket => answerQueries(socket, { '?Q104': 'MODE, MEM' }));
    connector = new HaasConnector({ id: 'vf2', name: 'VF2', host: '127.0.0.1', dataPort: CLOSED_PORT, queryPort });

    const first = await connector.poll();

    expect(first.errors).toContain(QUERY_TOO_LARGE);
    expect(first.data.mode).toBeUndefined();
    expect(await sentBytes[0]).toBeLessThan(MAX_HAAS_QUERY_REPLY_BYTES + SOCKET_BUFFER_MARGIN);

    const { errors } = await pollUntil(status => status.data.mode === 'MEM');

    expect(sockets).toHaveLength(2);
    expect(errors).not.toContain(QUERY_TOO_LARGE);
    expect(log.text('warn').split('\n')).toHaveLength(1);
    expect(log.text('warn')).toContain(String(MAX_HAAS_QUERY_REPLY_BYTES));
  });

  it('reads a data stream line of exactly the limit, when the delimiter comes in the next chunk', async () => {
    const line = 'ActiveTool|7|';
    const dataPort = await startSlowPort([line + 'X'.repeat(MAX_HAAS_LINE_BYTES - line.length), DELIMITER]);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });

    const { errors } = await pollUntil(status => status.data.toolNumber === 7);

    expect(dataStreamErrors(errors)).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('closes the data stream at a line of one byte more than the limit', async () => {
    const line = 'ActiveTool|7|';
    const dataPort = await startSlowPort([line + 'X'.repeat(MAX_HAAS_LINE_BYTES + 1 - line.length)]);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort, queryPort: CLOSED_PORT });

    const { status, errors } = await pollUntil(next => dataStreamErrors(next.errors).length > 0);

    expect(dataStreamErrors(errors)).toEqual([LINE_TOO_LARGE]);
    expect(status.data.toolNumber).toBeUndefined();
  });

  it('reads a query reply of exactly the limit, when the end of line comes in the next chunk', async () => {
    const reply = '>MODE, MEM';
    const queryPort = await startSlowPort([reply + ' '.repeat(MAX_HAAS_QUERY_REPLY_BYTES - reply.length), '\n']);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort: CLOSED_PORT, queryPort });

    const status = await connector.poll();

    expect(status.errors).not.toContain(QUERY_TOO_LARGE);
    expect(status.data.mode).toBe('MEM');
  });

  it('fails a query reply of one byte more than the limit', async () => {
    const reply = '>MODE, MEM';
    const queryPort = await startSlowPort([reply + ' '.repeat(MAX_HAAS_QUERY_REPLY_BYTES + 1 - reply.length)]);
    connector = new HaasConnector({ name: 'VF2', host: '127.0.0.1', dataPort: CLOSED_PORT, queryPort });

    const status = await connector.poll();

    expect(status.errors).toContain(QUERY_TOO_LARGE);
    expect(status.data.mode).toBeUndefined();
  });
});
