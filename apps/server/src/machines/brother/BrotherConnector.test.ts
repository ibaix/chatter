import net from 'net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BrotherConnector, NO_REPLY_ERROR, REPLY_STATUS_KEY, TRANSFORMS, brotherCommand, parseValue } from './BrotherConnector.js';
import type { BrotherMachineConfig, DataItemTransform } from '../../types/index.js';

/**
 * Replies of a Brother control to each command, matching the Python test fixtures
 */
const MOCK_RESPONSES: Record<string, string> = {
  'PANEL': 'RLOD    PANEL   00\r\nD01,0,0,0\r\nK01,0,5,0,0,0,0,0,0,0,1,0\r\nS01,4,100,100,1,0,1,1\r\n\r\n10%',
  'MEM': "RLOD    MEM     00\r\nA01,'/       ',1001,0,0,0,0,0\r\n\r\n00%",
  'WKCNTR': 'RLOD    WKCNTR  00\r\nA01,  1,    78,   200,     0\r\nA02,  0,     0,     0,     0\r\n\r\n08%',
  'PDSP': "RLOD    PDSP    00\r\nX01,    0.000 ,     0,0,10,10,10,0,0,0,0,4,100,100, 0,0, 0\r\n\r\n03%",
  'ALARM': "RLOD    ALARM   00\r\nE01,0975320032,          ,          \r\n\r\n10%",
  'ATCTL': 'RLOD    ATCTL   00\r\nM02,  1,0,0\r\nM03,  2,0,0\r\n\r\n00%',
  'TOLNI1': "RLOD    TOLNI1  00\r\nT01, 1.5000, 0.0000, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n\r\n00%"
};

function newConnector(config: Partial<BrotherMachineConfig> = {}): BrotherConnector {
  return new BrotherConnector({ name: 'Test', host: '192.168.1.100', ...config });
}

/** A connected connector that gets these replies; a command with no reply fails */
function connectorWithReplies(
  replies: Record<string, string>,
  config: Partial<BrotherMachineConfig> = {},
): BrotherConnector {
  const connector = newConnector({ id: 'b1', name: 'Speedio', host: '127.0.0.1', ...config });
  Object.assign(connector, { socket: {}, connected: true });
  vi.spyOn(connector, 'sendCommand').mockImplementation(async command => {
    if (!replies[command]) throw new Error(`No reply for ${command}`);
    return connector.parseResponse(replies[command]);
  });
  return connector;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrotherConnector', () => {
  let connector: BrotherConnector;

  beforeEach(() => {
    connector = newConnector({ id: 'test_brother', name: 'FakeBrother', host: '127.0.0.1', dataPort: 10000, timeout: 5000 });
  });

  afterEach(() => {
    connector.disconnect();
  });

  describe('constructor', () => {
    it('should initialize with correct defaults', () => {
      expect(connector.host).toBe('127.0.0.1');
      expect(connector.dataPort).toBe(10000);
      expect(connector.connected).toBe(false);
    });

    it('should use default port 10000', () => {
      expect(newConnector().dataPort).toBe(10000);
    });

    it('should generate id with brother_ prefix', () => {
      expect(newConnector().id).toMatch(/^brother_\d+$/);
    });

    it('should default to inches unit', () => {
      expect(newConnector().defaultUnit).toBe('in');
    });

    it('should accept metric unit', () => {
      expect(newConnector({ defaultUnit: 'mm' }).defaultUnit).toBe('mm');
    });
  });

  describe('disconnect', () => {
    it('should set connected to false', () => {
      connector.connected = true;
      connector.disconnect();

      expect(connector.connected).toBe(false);
    });
  });

  describe('checkConnection', () => {
    it('should return false when not connected', () => {
      expect(connector.checkConnection()).toBe(false);
    });
  });

  describe('sendCommand', () => {
    it('should reject when not connected', async () => {
      connector.connected = false;

      await expect(connector.sendCommand('PANEL')).rejects.toThrow('Not connected');
    });
  });

  describe('getStatus', () => {
    it('should return current status object', () => {
      connector.connected = true;

      const status = connector.getStatus();

      expect(status.id).toBe('test_brother');
      expect(status.name).toBe('FakeBrother');
      expect(status.host).toBe('127.0.0.1');
      expect(status.connected).toBe(true);
      expect(status.type).toBe('brother');
      expect(status.data).toBeDefined();
    });

    it('should use camelCase field names in status data', () => {
      const status = connector.getStatus();

      expect(status.data).not.toHaveProperty('Mode');
      expect(status.data).not.toHaveProperty('Part Count');
      expect(status.data).not.toHaveProperty('Tool Number');
    });

    it('should include macros in status when configured', () => {
      const macroConnector = newConnector({
        macros: [
          { location: 100, name: 'Custom Var' },
          { location: 200 }
        ]
      });

      const status = macroConnector.getStatus();

      expect(status.macros).toHaveLength(2);
      expect(status.macros![0].location).toBe(100);
      expect(status.macros![0].name).toBe('Custom Var');
      expect(status.macros![1].location).toBe(200);
    });
  });

  describe('updateMacros', () => {
    it('should update macros via updateMacros method', () => {
      expect(connector.macros).toHaveLength(0);

      connector.updateMacros([{ location: 500, name: 'New Macro' }]);

      expect(connector.macros).toHaveLength(1);
      expect(connector.macros[0].location).toBe(500);
      expect(connector.macros[0].name).toBe('New Macro');
    });
  });
});

describe('brotherCommand', () => {
  it('should build a properly formatted CLOD command', () => {
    const cmd = brotherCommand('PANEL');

    expect(cmd.startsWith('%')).toBe(true);
    expect(cmd).toContain('CLOD');
    expect(cmd).toContain('PANEL');
    expect(cmd).toMatch(/\d{2}%\r\n$/);
  });

  it('should pad command names to 8 characters', () => {
    expect(brotherCommand('MEM')).toContain('MEM     ');
  });

  it('should calculate consistent checksum', () => {
    expect(brotherCommand('PANEL')).toBe(brotherCommand('PANEL'));
    expect(brotherCommand('ALARM')).toBe(brotherCommand('ALARM'));
  });
});

describe('parseResponse', () => {
  const connector = newConnector();

  it('should parse PANEL response correctly', () => {
    const response = connector.parseResponse(MOCK_RESPONSES['PANEL']);
    expect(response['K01']).toBeDefined();
    expect(response['K01'][0]).toBe('0');
  });

  it('should parse MEM response correctly', () => {
    const response = connector.parseResponse(MOCK_RESPONSES['MEM']);
    expect(response['A01']).toBeDefined();
    expect(response['A01'][1]).toBe('1001');
  });

  it('should parse WKCNTR response correctly', () => {
    const response = connector.parseResponse(MOCK_RESPONSES['WKCNTR']);
    expect(response['A01']).toBeDefined();
    expect(response['A01'][1]).toBe('78');
    expect(response['A01'][2]).toBe('200');
  });

  it('should parse ALARM response correctly', () => {
    const response = connector.parseResponse(MOCK_RESPONSES['ALARM']);
    expect(response['E01']).toBeDefined();
    expect(response['E01'][0]).toBe('0975320032');
  });

  it('should parse PDSP response correctly', () => {
    const response = connector.parseResponse(MOCK_RESPONSES['PDSP']);
    expect(response['X01']).toBeDefined();
    expect(response['X01'][3]).toBe('10');
  });

  it('should handle empty lines gracefully', () => {
    const response = connector.parseResponse('A01,1,2,3\r\n\r\nB01,4,5,6');
    expect(response['A01']).toEqual(['1', '2', '3']);
    expect(response['B01']).toEqual(['4', '5', '6']);
  });

  it('should parse comma-separated values', () => {
    const response = connector.parseResponse('A01,value1,value2,value3\r\n');
    expect(response['A01']).toEqual(['value1', 'value2', 'value3']);
  });

  it('should skip lines without comma', () => {
    const response = connector.parseResponse('HEADER\r\nA01,value\r\n');
    expect(response['HEADER']).toBeUndefined();
    expect(response['A01']).toEqual(['value']);
  });

  it('should trim whitespace from values', () => {
    const response = connector.parseResponse('A01,  spaced  , value \r\n');
    expect(response['A01']).toEqual(['spaced', 'value']);
  });
});

describe('parseValue', () => {
  it('should parse string values', () => {
    expect(parseValue('hello', 'string')).toBe('hello');
  });

  it('should parse int values', () => {
    expect(parseValue('42', 'int')).toBe(42);
    expect(parseValue('3.7', 'int')).toBe(3);
  });

  it('should parse float values', () => {
    expect(parseValue('3.14', 'float')).toBe(3.14);
  });

  it('should parse bool values', () => {
    expect(parseValue('true', 'bool', (v) => Boolean(v))).toBe(true);
  });

  it('should strip quotes from strings', () => {
    expect(parseValue("'quoted'", 'string')).toBe('quoted');
  });

  it('should handle empty values with defaults', () => {
    expect(parseValue('', 'int')).toBe(0);
    expect(parseValue('', 'float')).toBe(0);
    expect(parseValue('', 'bool')).toBe(false);
    expect(parseValue('', 'string')).toBe('');
  });

  it('should apply transform function', () => {
    const double: DataItemTransform = (v) => parseInt(String(v)) * 2;
    expect(parseValue('5', 'int', double)).toBe(10);
  });
});

describe('TRANSFORMS.mode', () => {
  it.each([
    ['0', 'MANUAL'],
    ['1', 'MDI'],
    ['2', 'MEMORY'],
    ['3', 'EDIT'],
  ])('should transform %s to %s', (panelValue, mode) => {
    expect(TRANSFORMS.mode(panelValue)).toBe(mode);
  });

  it('should return raw int for unknown values', () => {
    expect(TRANSFORMS.mode('4')).toBe(4);
    expect(TRANSFORMS.mode('99')).toBe(99);
  });
});

describe('TRANSFORMS.alarm', () => {
  it('should return false for CM (Communication) alarm - ignored', () => {
    expect(TRANSFORMS.alarm('0975320032')).toBe(false);
  });

  it('should return false for OM (No alarm) - ignored', () => {
    expect(TRANSFORMS.alarm('90')).toBe(false);
    expect(TRANSFORMS.alarm('90000000')).toBe(false);
  });

  it('should return true for real alarms', () => {
    expect(TRANSFORMS.alarm('01123456')).toBe(true);  // EX
    expect(TRANSFORMS.alarm('02123456')).toBe(true);  // EC
    expect(TRANSFORMS.alarm('03123456')).toBe(true);  // SV
    expect(TRANSFORMS.alarm('04123456')).toBe(true);  // NC
    expect(TRANSFORMS.alarm('05123456')).toBe(true);  // IO
    expect(TRANSFORMS.alarm('06123456')).toBe(true);  // SP
    expect(TRANSFORMS.alarm('10123456')).toBe(true);  // ES
  });
});

describe('TRANSFORMS.alarmCode', () => {
  it.each([
    ['01', 'EX'], ['02', 'EC'], ['03', 'SV'], ['04', 'NC'], ['05', 'IO'], ['06', 'SP'],
    ['07', 'SM'], ['08', 'SL'], ['09', 'CM'], ['10', 'ES'], ['11', 'FC'],
  ])('maps prefix %s to %s', (prefix, letters) => {
    expect(TRANSFORMS.alarmCode(`${prefix}123456`)).toBe(`${letters}123456`);
  });

  it('should transform CM alarm code correctly', () => {
    expect(TRANSFORMS.alarmCode('0975320032')).toBe('CM75320032');
  });

  it('should return empty string for OM (No alarm)', () => {
    expect(TRANSFORMS.alarmCode('90')).toBe('');
    expect(TRANSFORMS.alarmCode('90000000')).toBe('');
  });

  it('should return raw value for unknown codes', () => {
    expect(TRANSFORMS.alarmCode('99unknown')).toBe('99unknown');
  });
});

describe('TRANSFORMS.execution, from the MEM operation status', () => {
  it('gives the MTConnect execution word for each status', () => {
    expect(TRANSFORMS.execution('0')).toBe('READY');
    expect(TRANSFORMS.execution('1')).toBe('ACTIVE');
    expect(TRANSFORMS.execution('2')).toBe('FEED_HOLD');
    expect(TRANSFORMS.execution('3')).toBe('INTERRUPTED');
  });

  it('gives an empty value for a status that it does not know', () => {
    expect(TRANSFORMS.execution('7')).toBe('');
  });
});

describe('Brother control type detection (C00 vs D00)', () => {
  it('should start with null controlType before detection', () => {
    const status = newConnector().getStatus();

    expect(status.data).toHaveProperty('controlType');
    expect(status.data.controlType).toBeNull();
  });

  it('is a C00 control when ATCTL gives ATC pots', async () => {
    const status = await connectorWithReplies(MOCK_RESPONSES).poll();

    expect(status.data.controlType).toBe('C00');
  });

  it('is a D00 control when ATCTL is unknown and ATCTLD gives ATC pots', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      ATCTL: 'RLOD    ATCTL   08\r\n01%',
      ATCTLD: MOCK_RESPONSES.ATCTL.replace('ATCTL ', 'ATCTLD'),
    });

    const status = await connector.poll();

    expect(status.data.controlType).toBe('D00');
  });

  it('has no control type when the control knows neither command', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      ATCTL: 'RLOD    ATCTL   08\r\n01%',
      ATCTLD: 'RLOD    ATCTLD  08\r\n02%',
    });

    const status = await connector.poll();

    expect(status.data.controlType).toBeNull();
    expect(status.data.hasPocketInfo).toBe(false);
  });
});

describe('Brother tool table from a poll', () => {
  it('puts the tool of each ATC pot in the table, with the offsets and name from the tool data', async () => {
    const status = await connectorWithReplies(MOCK_RESPONSES).poll();

    expect(status.data.hasPocketInfo).toBe(true);
    expect(status.data.toolTable).toEqual({
      1: { toolNum: 1, length: 1.5, lengthWear: 0, diameter: 0.25, diameterWear: 0, name: 'ENDMILL' },
      2: { toolNum: 2 },
    });
  });

  it('reads tool data with 3-digit keys', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      TOLNI1: "RLOD    TOLNI1  00\r\nT001, 1.5000, 0.0001, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n\r\n00%",
    });

    const status = await connector.poll();

    expect(status.data.toolTable?.[1]).toMatchObject({ length: 1.5, lengthWear: 0.0001, name: 'ENDMILL' });
  });

  it('asks for metric tool data when the unit is mm', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, TOLNM1: MOCK_RESPONSES.TOLNI1 }, { defaultUnit: 'mm' });

    await connector.poll();

    expect(connector.sendCommand).toHaveBeenCalledWith('TOLNM1');
    expect(connector.sendCommand).not.toHaveBeenCalledWith('TOLNI1');
  });
});

describe('Brother Data Snapshot', () => {
  let connector: BrotherConnector;

  beforeEach(() => {
    connector = newConnector({ name: 'SnapshotTest', macros: [{ location: 100, name: 'TestMacro' }] });
  });

  afterEach(() => {
    connector.disconnect();
  });

  it('should include machine identification', () => {
    const snapshot = connector.getDataSnapshot();

    expect(snapshot.machineId).toBeDefined();
    expect(snapshot.machineType).toBe('brother');
    expect(snapshot.timestamp).toBeDefined();
  });

  it('should include connection status', () => {
    expect(connector.getDataSnapshot().connected).toBe(false);
  });

  it('should include standard fields', () => {
    const snapshot = connector.getDataSnapshot();

    // These may be undefined when not connected, but the fields should exist
    expect('mode' in snapshot).toBe(true);
    expect('program' in snapshot).toBe(true);
    expect('spindleSpeed' in snapshot).toBe(true);
    expect('toolNumber' in snapshot).toBe(true);
    expect('partCount' in snapshot).toBe(true);
    expect('partGoal' in snapshot).toBe(true);
  });

  it('should include alarm fields', () => {
    const snapshot = connector.getDataSnapshot();

    expect('alarm' in snapshot).toBe(true);
    expect('alarmCode' in snapshot).toBe(true);
  });
});

describe('Brother run state from a poll', () => {
  function connectorWithMem(memReply: string): BrotherConnector {
    return connectorWithReplies({ ...MOCK_RESPONSES, MEM: memReply });
  }

  it('reads index 2 of the MEM A01 line, the operation status, so the history can record the running time', async () => {
    const connector = connectorWithMem("RLOD    MEM     00\r\nA01,'/       ',1001,1,0,0,0,0\r\n\r\n00%");

    const status = await connector.poll();

    expect(status.data.execution).toBe('ACTIVE');
    expect(connector.getDataSnapshot().execution).toBe('ACTIVE');
  });

  it('gives no run state when the control sends no operation status', async () => {
    const connector = connectorWithMem("RLOD    MEM     00\r\nA01,'/       ',1001\r\n\r\n00%");

    await connector.poll();

    expect(connector.getDataSnapshot().execution).toBeUndefined();
  });
});

/** A short timeout, so that a test does not wait long for a machine that does not answer */
const SHORT_TIMEOUT_MS = 150;

/** The open connections of each test server, so that closeServer can end them */
const serverSockets = new WeakMap<net.Server, Set<net.Socket>>();

/** A TCP server on a free port of this computer. `onSocket` gets each connection. */
function startServer(onSocket: (socket: net.Socket) => void): Promise<net.Server> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onSocket(socket);
  });
  serverSockets.set(server, sockets);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function closeServer(server: net.Server): Promise<void> {
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  return new Promise(resolve => server.close(() => resolve()));
}

/** Answers each command the way a Brother control does. A command that it does not know gets an empty reply. */
function answerLikeABrother(socket: net.Socket): void {
  socket.on('data', chunk => {
    const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
    socket.write('%' + (MOCK_RESPONSES[command] ?? `RLOD    ${command.padEnd(8)}01\r\n\r\n00%`));
  });
}

describe('Brother connection problems, with a real TCP connection', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector;

  function connectorFor(port: number): BrotherConnector {
    connector = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: port, timeout: SHORT_TIMEOUT_MS });
    return connector;
  }

  afterEach(async () => {
    connector?.disconnect();
    if (server) await closeServer(server);
    server = null;
  });

  it('tells that another program can hold the connection when the machine accepts it but does not answer', async () => {
    server = await startServer(() => { /* accepts the connection, and never answers */ });

    const status = await connectorFor(portOf(server)).poll();

    expect(status.connected).toBe(false);
    expect(status.errors).toEqual([NO_REPLY_ERROR]);
  });

  it('connects again on the next poll after a machine did not answer', async () => {
    let connections = 0;
    server = await startServer(() => { connections++; });
    const silent = connectorFor(portOf(server));
    await silent.poll();

    await silent.poll();

    expect(connections).toBe(2);
  });

  it('gives a socket error, not the no-answer message, when nothing listens on the port', async () => {
    server = await startServer(() => {});
    const port = portOf(server);
    await closeServer(server);
    server = null;

    const status = await connectorFor(port).poll();

    expect(status.connected).toBe(false);
    expect(status.errors[0]).toMatch(/^Socket error: connect ECONNREFUSED/);
    expect(status.errors).not.toContain(NO_REPLY_ERROR);
  });

  it('gives "Connection timeout" when the connection does not open in time', async () => {
    // The connect never ends, as with a machine that is off behind a router
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { return this; });

    const status = await connectorFor(10000).poll();

    expect(status.connected).toBe(false);
    expect(status.errors[0]).toBe('Connection timeout');
    expect(status.errors).not.toContain(NO_REPLY_ERROR);
  });

  it('gives no error when the machine answers each command', async () => {
    server = await startServer(answerLikeABrother);

    const status = await connectorFor(portOf(server)).poll();

    expect(status.errors).toEqual([]);
    expect(status.connected).toBe(true);
    expect(status.data.partCount).toBe(78);
  });

  it('does not read a late reply as the reply to a command of the next poll', async () => {
    // A control answers in order. The first PANEL reply comes after the timeout, and it has an old mode (EDIT).
    const lateReply = '%' + MOCK_RESPONSES.PANEL.replace('K01,0,', 'K01,3,');
    let panelCommands = 0;
    server = await startServer(socket => {
      let replies = Promise.resolve();
      socket.on('data', chunk => {
        const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
        const late = command === 'PANEL' && ++panelCommands === 1;
        const reply = late ? lateReply : '%' + (MOCK_RESPONSES[command] ?? `RLOD    ${command.padEnd(8)}01\r\n\r\n00%`);
        replies = replies
          .then(() => new Promise(resolve => setTimeout(resolve, late ? SHORT_TIMEOUT_MS + 50 : 0)))
          .then(() => { if (!socket.destroyed) socket.write(reply); });
      });
    });
    const slowOnce = connectorFor(portOf(server));

    const first = await slowOnce.poll();
    // At once, so the next poll waits for its PANEL reply when the late reply comes
    const next = await slowOnce.poll();

    expect(first.errors).toEqual([NO_REPLY_ERROR]);
    expect(next.errors).toEqual([]);
    expect(next.data.mode).toBe('MANUAL');
    expect(next.data.partCount).toBe(78);
  });

  it('connects again on the next poll after the machine closed the connection', async () => {
    const machineSides: net.Socket[] = [];
    server = await startServer(socket => {
      machineSides.push(socket);
      answerLikeABrother(socket);
    });
    const answering = connectorFor(portOf(server));
    await answering.poll();

    machineSides[0].end();
    await vi.waitFor(() => expect(answering.connected).toBe(false));
    const status = await answering.poll();

    expect(machineSides).toHaveLength(2);
    expect(status.errors).toEqual([]);
    expect(status.data.partCount).toBe(78);
  });

  it('stays connected when the old connection closes after a new connect', async () => {
    server = await startServer(answerLikeABrother);
    const answering = connectorFor(portOf(server));
    await answering.connect();
    const oldSocket = (answering as unknown as { socket: net.Socket }).socket;
    await answering.connect();
    await new Promise(resolve => (oldSocket.closed ? resolve(undefined) : oldSocket.once('close', resolve)));

    // A late 'close' of the old socket, as when it comes after the new connection opened
    oldSocket.emit('close', false);

    expect(answering.connected).toBe(true);
  });

  it('stays connected with no error when the time between two polls is longer than the timeout', async () => {
    server = await startServer(answerLikeABrother);
    const answering = connectorFor(portOf(server));
    await answering.poll();

    await new Promise(resolve => setTimeout(resolve, SHORT_TIMEOUT_MS * 2));

    expect(answering.getStatus().errors).toEqual([]);
    expect(answering.connected).toBe(true);
  });
});

describe('Brother command when the connection closes', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector;

  afterEach(async () => {
    connector?.disconnect();
    if (server) await closeServer(server);
    server = null;
  });

  /** Connected to a server that never answers, with a timeout that the test never reaches */
  async function connectedToSilentServer(): Promise<BrotherConnector> {
    server = await startServer(() => {});
    connector = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: portOf(server), timeout: 60_000 });
    await connector.connect();
    return connector;
  }

  it('ends a waiting command with an error when Chatter disconnects, so the poll does not wait forever', async () => {
    const silent = await connectedToSilentServer();
    const command = silent.sendCommand('PANEL');

    silent.disconnect();

    await expect(command).rejects.toThrow('The connection closed before the machine answered');
  });

  it('ends a waiting command with an error when the machine closes the connection', async () => {
    let machineSide: net.Socket | undefined;
    server = await startServer(socket => { machineSide = socket; });
    connector = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: portOf(server), timeout: 60_000 });
    await connector.connect();
    await vi.waitFor(() => expect(machineSide).toBeDefined());
    const command = connector.sendCommand('PANEL');

    machineSide!.end();

    await expect(command).rejects.toThrow('The connection closed before the machine answered');
  });

  it('ends a connect with an error when Chatter disconnects before the connection opens', async () => {
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { return this; });
    connector = newConnector({ id: 'b1', host: '127.0.0.1', timeout: 60_000 });
    const connecting = connector.connect();

    connector.disconnect();

    await expect(connecting).rejects.toThrow('The connection closed before it opened');
  });

  it('ends a poll with a reason when Chatter disconnects during a command', async () => {
    const silent = await connectedToSilentServer();
    // poll() runs at once up to the first command, which then waits for a reply
    const poll = silent.poll();

    silent.disconnect();
    const status = await poll;

    expect(status.connected).toBe(false);
    expect(status.errors.join('; ')).toContain('The connection closed before the machine answered');
  });
});

/** An empty slot of the alarm list: 10 spaces, as the control sends it */
const EMPTY_ALARM_SLOT = ' '.repeat(10);
/** The alarm list has about 36 slots */
const ALARM_SLOTS = 36;

/**
 * An ALARM reply in the shape of a real Speedio X500 (C00): E01 with each alarm slot, then L01.
 * `slots` are the first slots; the others are empty.
 */
function alarmReply(slots: string[]): string {
  const e01 = [...slots, ...Array(ALARM_SLOTS - slots.length).fill(EMPTY_ALARM_SLOT)].join(',');
  const l01 = Array(ALARM_SLOTS).fill(' '.repeat(11)).join(',');
  return `RLOD    ALARM   00\r\nE01,${e01}\r\nL01,${l01}\r\n\r\n12%`;
}

/** A communication message (CM, category 09). A Speedio adds one after it gets a command that it does not know. */
const CM_ENTRY = '0975220008';
const SV_ALARM = '0312345678';

describe('Brother alarm from the whole alarm list', () => {
  async function alarmOf(slots: string[]) {
    const status = await connectorWithReplies({ ...MOCK_RESPONSES, ALARM: alarmReply(slots) }).poll();
    return { alarm: status.data.alarm, alarmCode: status.data.alarmCode };
  }

  it('gives no alarm for an empty list', async () => {
    expect(await alarmOf([])).toEqual({ alarm: false, alarmCode: '' });
  });

  it('gives no alarm when the list has only a communication message', async () => {
    expect(await alarmOf([CM_ENTRY])).toEqual({ alarm: false, alarmCode: '' });
  });

  it('finds a real alarm after a communication message in the first slot', async () => {
    expect(await alarmOf([CM_ENTRY, SV_ALARM])).toEqual({ alarm: true, alarmCode: 'SV12345678' });
  });

  it('finds a real alarm in the first slot, as before', async () => {
    expect(await alarmOf([SV_ALARM])).toEqual({ alarm: true, alarmCode: 'SV12345678' });
  });

  it('gives the code of the first real alarm when there are more, and skips "no alarm" entries', async () => {
    expect(await alarmOf(['9000000000', '0512340000', SV_ALARM])).toEqual({ alarm: true, alarmCode: 'IO12340000' });
  });
});

/** The real reply of a Speedio X500 (C00) to ATCTLD: status 08, a command that it does not know */
const UNKNOWN_ATCTLD = 'RLOD    ATCTLD  08\r\n02%';
const UNKNOWN_ATCTL = 'RLOD    ATCTL   08\r\n01%';
const D00_ATCTLD = MOCK_RESPONSES.ATCTL.replace('ATCTL ', 'ATCTLD');

/** Each command that the connector sent, in order */
const sentCommands = (connector: BrotherConnector) => vi.mocked(connector.sendCommand).mock.calls.map(([command]) => command);

/** Connect at once, with no real socket, when the connector connects */
function connectWithNoSocket(connector: BrotherConnector): void {
  Object.assign(connector, { socket: { destroy: () => {} } });
  vi.spyOn(connector, 'connect').mockImplementation(async () => {
    Object.assign(connector, { socket: { destroy: () => {} }, connected: true });
  });
}

/** Poll `count` times, and connect again before each poll */
async function pollWithReconnects(connector: BrotherConnector, count: number): Promise<void> {
  connectWithNoSocket(connector);
  for (let i = 0; i < count; i++) {
    connector.disconnect();
    await connector.poll();
  }
}

describe('Brother control type, found once by the reply status', () => {
  it('gives the status of the reply', () => {
    const connector = newConnector();

    expect(connector.parseResponse(UNKNOWN_ATCTLD)[REPLY_STATUS_KEY]).toEqual(['08']);
    expect(connector.parseResponse(MOCK_RESPONSES.PANEL)[REPLY_STATUS_KEY]).toEqual(['00']);
    expect(connector.parseResponse(MOCK_RESPONSES.TOLNI1)[REPLY_STATUS_KEY]).toEqual(['00']);
  });

  it('never sends ATCTLD to a C00 control, across reconnects', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTLD: UNKNOWN_ATCTLD });

    await pollWithReconnects(connector, 3);

    expect(sentCommands(connector)).not.toContain('ATCTLD');
    expect(connector.getStatus().data.controlType).toBe('C00');
  });

  it('is a C00 control when ATCTL answers with status 00 and no pots, and does not try ATCTLD', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: 'RLOD    ATCTL   00\r\n\r\n00%', ATCTLD: UNKNOWN_ATCTLD });

    const status = await connector.poll();

    expect(status.data.controlType).toBe('C00');
    expect(sentCommands(connector)).not.toContain('ATCTLD');
  });

  it('on a D00 control, sends ATCTL one time only, and then ATCTLD', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: D00_ATCTLD });

    await pollWithReconnects(connector, 3);

    expect(sentCommands(connector).filter(command => command === 'ATCTL')).toHaveLength(1);
    expect(sentCommands(connector).filter(command => command === 'ATCTLD').length).toBeGreaterThanOrEqual(3);
    expect(connector.getStatus().data.controlType).toBe('D00');
    expect(connector.getStatus().data.toolTable?.[1]).toMatchObject({ toolNum: 1 });
  });

  it('asks no ATC command again when the control knows neither, and still reads the tool data', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: UNKNOWN_ATCTLD });

    await pollWithReconnects(connector, 3);

    expect(sentCommands(connector).filter(command => command.startsWith('ATCTL'))).toEqual(['ATCTL', 'ATCTLD']);
    expect(connector.getStatus().data.controlType).toBeNull();
    expect(sentCommands(connector).filter(command => command === 'TOLNI1')).toHaveLength(3);
  });

  it('sends no macro command when no macro is set', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);

    await connector.poll();

    expect(sentCommands(connector).some(command => command.startsWith('MCRN'))).toBe(false);
  });
});

/** The first send of `command` fails: `fail` runs, and its error is the result */
function failFirstSend(connector: BrotherConnector, command: string, fail: () => Error): void {
  const answer = vi.mocked(connector.sendCommand).getMockImplementation()!;
  let failed = false;
  vi.mocked(connector.sendCommand).mockImplementation(async sent => {
    if (sent === command && !failed) {
      failed = true;
      throw fail();
    }
    return answer(sent);
  });
}

describe('Brother control type when a send fails during the detection', () => {
  it.each([
    ['"Not connected", after the machine closed its side and before the close event', () => () => new Error('Not connected')],
    ['a closed connection', (connector: BrotherConnector) => () => {
      connector.connected = false;
      return new Error('The connection closed before the machine answered');
    }],
  ])('does not remember "knows neither" after %s on ATCTL, and finds C00 later', async (_, failure) => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTLD: UNKNOWN_ATCTLD });
    connectWithNoSocket(connector);
    failFirstSend(connector, 'ATCTL', failure(connector));

    const failed = await connector.poll();
    await pollWithReconnects(connector, 1);

    expect(failed.errors.join('; ')).toMatch(/Poll failed/);
    expect(sentCommands(connector)).not.toContain('ATCTLD');
    expect(connector.getStatus().data.controlType).toBe('C00');
    expect(connector.getStatus().data.hasPocketInfo).toBe(true);
  });

  it('on a D00, finds D00 later when ATCTLD gets "Not connected", and does not send ATCTL again', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: D00_ATCTLD });
    connectWithNoSocket(connector);
    failFirstSend(connector, 'ATCTLD', () => new Error('Not connected'));

    await connector.poll();
    await pollWithReconnects(connector, 2);

    expect(sentCommands(connector).filter(command => command === 'ATCTL')).toHaveLength(1);
    expect(connector.getStatus().data.controlType).toBe('D00');
    expect(connector.getStatus().data.hasPocketInfo).toBe(true);
    expect(connector.getStatus().data.toolTable?.[1]).toMatchObject({ toolNum: 1 });
  });
});

describe('Brother control type when the machine does not answer ATCTL, with a real TCP connection', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector | undefined;

  afterEach(async () => {
    connector?.disconnect();
    if (server) await closeServer(server);
    server = null;
  });

  it('sends ATCTL again at the next detection, finds C00, and sends no ATCTLD after the timeout', async () => {
    const commands: string[] = [];
    server = await startServer(socket => {
      socket.on('data', chunk => {
        const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
        commands.push(command);
        // The first ATCTL gets no reply
        if (command === 'ATCTL' && commands.filter(sent => sent === 'ATCTL').length === 1) return;
        socket.write('%' + (MOCK_RESPONSES[command] ?? UNKNOWN_ATCTLD));
      });
    });
    connector = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: portOf(server), timeout: SHORT_TIMEOUT_MS });

    const first = await connector.poll();
    const next = await connector.poll();

    expect(first.errors).toEqual([NO_REPLY_ERROR]);
    expect(next.errors).toEqual([]);
    expect(next.data.controlType).toBe('C00');
    expect(commands).not.toContain('ATCTLD');
    expect(commands.filter(sent => sent === 'ATCTL').length).toBeGreaterThanOrEqual(2);
  });
});
