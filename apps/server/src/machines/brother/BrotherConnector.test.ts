import net from 'net';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BROTHER_RECONNECT_MS, BrotherConnector, NO_REPLY_ERROR } from './BrotherConnector.js';
import { parseResponse } from './brotherProtocol.js';
import { MOCK_RESPONSES } from './testSupport.js';
import type { BrotherMachineConfig, BrotherMachineStatus } from '../../types/index.js';
import { TOOL_SYNC_TIMEOUT_MS } from './toolSync.js';
import { captureLog, type CapturedLog } from '../../logging/testSupport.js';
import { ConnectionLog } from '../../logging/ConnectionLog.js';
import { HardwarePoller } from '../../polling/poller.js';
import type { MachineRegistry } from '../../polling/MachineRegistry.js';

function newConnector(config: Partial<BrotherMachineConfig> = {}): BrotherConnector {
  return new BrotherConnector({ name: 'Test', host: '192.168.1.100', ...config });
}

/** A connected connector that gets these replies; a command with no reply fails */
function connectorWithReplies(
  replies: Record<string, string>,
  config: Partial<BrotherMachineConfig> = {},
): BrotherConnector {
  const connector = newConnector({ id: 'b1', name: 'Speedio', host: '127.0.0.1', ...config });
  // A poll that fails destroys the socket
  Object.assign(connector, { socket: { destroy: () => {} }, connected: true });
  vi.spyOn(connector, 'sendCommand').mockImplementation(async command => {
    if (!replies[command]) throw new Error(`No reply for ${command}`);
    return parseResponse(replies[command]);
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

describe('Brother control type detection (C00 vs D00)', () => {
  it('should start with null controlType before detection', () => {
    const status = newConnector().getStatus();

    expect(status.data).toHaveProperty('controlType');
    expect(status.data.controlType).toBeNull();
  });

  it('is a C00 control when ATCTL gives ATC pots', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);

    await connector.requestToolSync();

    expect(connector.getStatus().data.controlType).toBe('C00');
  });

  it('is a D00 control when ATCTL is unknown and ATCTLD gives ATC pots', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      ATCTL: 'RLOD    ATCTL   08\r\n01%',
      ATCTLD: MOCK_RESPONSES.ATCTL.replace('ATCTL ', 'ATCTLD'),
    });

    await connector.requestToolSync();

    expect(connector.getStatus().data.controlType).toBe('D00');
  });

  it('has no control type when the control knows neither command', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      ATCTL: 'RLOD    ATCTL   08\r\n01%',
      ATCTLD: 'RLOD    ATCTLD  08\r\n02%',
    });

    await connector.requestToolSync();

    expect(connector.getStatus().data.controlType).toBeNull();
    expect(connector.getStatus().data.hasPocketInfo).toBe(false);
  });
});

describe('Brother tool table from a tool sync', () => {
  it('puts the tool of each ATC pot in the table, with the offsets and name from the tool data', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);

    await connector.requestToolSync();

    const { data } = connector.getStatus();
    expect(data.hasPocketInfo).toBe(true);
    expect(data.toolTable).toEqual({
      1: { toolNum: 1, length: 1.5, lengthWear: 0, diameter: 0.25, diameterWear: 0, name: 'ENDMILL' },
      2: { toolNum: 2 },
    });
  });

  it('reads tool data with 3-digit keys', async () => {
    const connector = connectorWithReplies({
      ...MOCK_RESPONSES,
      TOLNI1: "RLOD    TOLNI1  00\r\nT001, 1.5000, 0.0001, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n\r\n00%",
    });

    await connector.requestToolSync();

    expect(connector.getStatus().data.toolTable?.[1]).toMatchObject({ length: 1.5, lengthWear: 0.0001, name: 'ENDMILL' });
  });

  it('asks for metric tool data when the unit is mm', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, TOLNM1: MOCK_RESPONSES.TOLNI1 }, { defaultUnit: 'mm' });

    await connector.requestToolSync();

    expect(connector.sendCommand).toHaveBeenCalledWith('TOLNM1');
    expect(connector.sendCommand).not.toHaveBeenCalledWith('TOLNI1');
  });
});

describe('Brother poll times in the status', () => {
  it('has no poll times before the first poll', () => {
    expect(newConnector().getStatus().pollTimings).toBeUndefined();
  });

  it('gives the time of each command and of the poll, and the poll limit', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);
    connector.pollTimeLimitMs = 8000;

    const status = await connector.poll();

    expect(status.pollTimings?.limitMs).toBe(8000);
    expect(Object.keys(status.pollTimings?.lastPoll.commands ?? {}).sort())
      .toEqual(['ALARM', 'MEM', 'PANEL', 'PDSP', 'WKCNTR']);
    expect(status.pollTimings?.commands.PANEL.samples).toBe(1);
    expect(status.pollTimings?.poll.samples).toBe(1);
  });

  it('does not show the commands of a tool read in the times of the last poll', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);

    await connector.poll();
    await connector.toolSyncEnded();

    const timings = connector.getStatus().pollTimings!;
    expect(Object.keys(timings.lastPoll.commands).sort()).toEqual(['ALARM', 'MEM', 'PANEL', 'PDSP', 'WKCNTR']);
    expect(timings.commands.ATCTL.samples).toBe(1);
  });

  it('records a poll that fails, so a slow machine shows its times', async () => {
    const { MEM: _mem, ...replies } = MOCK_RESPONSES;
    const connector = connectorWithReplies(replies);

    const status = await connector.poll();

    expect(status.errors.join(';')).toContain('No reply for MEM');
    expect(status.pollTimings?.lastPoll.commands).toHaveProperty('MEM');
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

describe('Brother socket options', () => {
  it('turns on TCP keepalive and sends each command at once', async () => {
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) { return this; });
    const keepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    const noDelay = vi.spyOn(net.Socket.prototype, 'setNoDelay');
    const connector = newConnector({ id: 'b1', host: '127.0.0.1', timeout: 60_000 });
    const connecting = connector.connect();

    connector.disconnect();
    await connecting.catch(() => {});

    expect(keepAlive).toHaveBeenCalledWith(true, expect.any(Number));
    expect(noDelay).toHaveBeenCalledWith(true);
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

const MACRO_REPLY = 'RLOD    MCRNI1  00\r\nC100, 42.0000\r\n\r\n00%';

/** A reply of PDSP with this tool in the spindle */
function pdspWithTool(tool: number): string {
  return `RLOD    PDSP    00\r\nX01,    0.000 ,     0,0,${tool},10,10,0,0,0,0,4,100,100, 0,0, 0\r\n\r\n03%`;
}

/** The machine state: each poll reads these */
const STATE_COMMANDS = ['PANEL', 'MEM', 'ALARM', 'WKCNTR', 'PDSP', 'MCRNI1'];
/** The tool table and the tool data */
const TOOL_COMMANDS = ['ATCTL', 'TOLNI1'];

const MEM_RUNNING = "RLOD    MEM     00\r\nA01,'/       ',1001,1,0,0,0,0\r\n\r\n00%";
const MEM_NO_RUN_STATE = "RLOD    MEM     00\r\nA01,'/       ',1001\r\n\r\n00%";

/**
 * A connected connector on a fake clock. Each reply takes `msPerCommand` on that clock.
 * `sent` lists the commands since the last poll started, and `replies` can change between polls.
 * `held` holds back the reply to a command until the test calls the function it puts there.
 */
function machineThatTakes(msPerCommand: number) {
  const replies: Record<string, string> = { ...MOCK_RESPONSES, MCRNI1: MACRO_REPLY };
  const sent: string[] = [];
  const held: { command?: string; release?: () => void } = {};
  const connector = newConnector({ id: 'b1', host: '127.0.0.1', macros: [{ location: 100, name: 'Count' }] });
  Object.assign(connector, { socket: { destroy: () => {} }, connected: true });
  vi.spyOn(connector, 'sendCommand').mockImplementation(async command => {
    sent.push(command);
    if (held.command === command) await new Promise<void>(resolve => { held.release = resolve; });
    vi.setSystemTime(Date.now() + msPerCommand);
    if (!replies[command]) throw new Error(`No reply for ${command}`);
    return parseResponse(replies[command]);
  });
  const poll = async () => {
    sent.length = 0;
    return connector.poll();
  };
  /** A poll, then the end of the tool sync that it can start */
  const pollAndSync = async () => {
    const status = await poll();
    await connector.toolSyncEnded();
    return status;
  };
  return { connector, replies, sent, held, poll, pollAndSync };
}

describe('Brother tool sync: the tool table and the tool data, read apart from the state polls', () => {
  beforeEach(() => {
    // Only the clock is fake: the replies come at once, but each one moves the clock
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads only the machine state in a poll, with the macros', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;

    await machine.pollAndSync();

    expect([...machine.sent].sort()).toEqual([...STATE_COMMANDS].sort());
  });

  it('does not read the tools while a program runs, also after 10 minutes and more', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;
    await machine.pollAndSync();

    vi.setSystemTime(Date.now() + 15 * 60_000);
    await machine.pollAndSync();

    expect(machine.sent).not.toEqual(expect.arrayContaining(['ATCTL']));
    expect(machine.sent).not.toContain('TOLNI1');
    expect(machine.connector.getStatus().data.toolSync?.lastSyncAt).toBeNull();
  });

  it('does not find the control type before the first tool read', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;

    const status = await machine.pollAndSync();

    expect(status.data.controlType).toBeNull();
    expect(machine.sent).not.toContain('ATCTL');
  });

  it('reads the tools after a poll that finds the machine idle, the first time at once', async () => {
    const machine = machineThatTakes(100);

    await machine.pollAndSync();

    expect(machine.sent.slice(-2)).toEqual(TOOL_COMMANDS);
    const { data } = machine.connector.getStatus();
    expect(data.toolTable?.[1]).toMatchObject({ toolNum: 1, length: 1.5, name: 'ENDMILL' });
    expect(data.controlType).toBe('C00');
    expect(data.toolSync).toEqual({ lastSyncAt: new Date(Date.now()).toISOString(), lastAttemptAt: new Date(Date.now()).toISOString(), error: null, running: false });
  });

  it('does not read the tools again while idle when the last read is 10 minutes old or less', async () => {
    const machine = machineThatTakes(100);
    await machine.pollAndSync();

    vi.setSystemTime(Date.now() + 10 * 60_000 - 1000);
    await machine.pollAndSync();

    expect(machine.sent).not.toContain('ATCTL');
  });

  it('reads the tools again while idle when the last read is more than 10 minutes old', async () => {
    const machine = machineThatTakes(100);
    await machine.pollAndSync();

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    await machine.pollAndSync();

    expect(machine.sent).toEqual(expect.arrayContaining(TOOL_COMMANDS));
  });

  it('with no run state from the control, reads the tools only when the spindle stands still', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_NO_RUN_STATE;
    machine.replies.PDSP = 'RLOD    PDSP    00\r\nX01,    0.000 ,  1200,0,10,10,10,0,0,0,0,4,100,100, 0,0, 0\r\n\r\n03%';
    await machine.pollAndSync();
    expect(machine.sent).not.toContain('ATCTL');

    machine.replies.PDSP = MOCK_RESPONSES.PDSP;
    await machine.pollAndSync();

    expect(machine.sent).toEqual(expect.arrayContaining(TOOL_COMMANDS));
  });

  it('keeps the tool table between reads, so it stays on the screen and in the history', async () => {
    const machine = machineThatTakes(100);
    await machine.pollAndSync();

    const status = await machine.pollAndSync();

    expect(status.data.toolTable?.[1]).toMatchObject({ toolNum: 1, length: 1.5, name: 'ENDMILL' });
    expect(machine.connector.getDataSnapshot().custom).toMatchObject({ toolTable: { 1: { toolNum: 1, length: 1.5 } } });
  });

  it('reads the tools at once when a user asks, also while a program runs', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;
    await machine.pollAndSync();

    const result = await machine.connector.requestToolSync();

    expect(result).toEqual({ outcome: 'synced', toolSync: expect.objectContaining({ error: null, running: false }) });
    expect(machine.sent).toEqual(expect.arrayContaining(TOOL_COMMANDS));
  });

  it('refuses a second request within 30 seconds, and a request while a read runs', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;
    await machine.connector.requestToolSync();

    expect(await machine.connector.requestToolSync()).toEqual({ outcome: 'too-soon', retryAfterSeconds: 30 });

    vi.setSystemTime(Date.now() + 30_000);
    machine.held.command = 'TOLNI1';
    const running = machine.connector.requestToolSync();
    await vi.waitFor(() => expect(machine.held.release).toBeDefined());
    expect(await machine.connector.requestToolSync()).toEqual({ outcome: 'busy' });
    machine.held.release!();
    expect((await running).outcome).toBe('synced');
  });

  it('refuses a request when the machine is not connected', async () => {
    const machine = machineThatTakes(100);
    machine.connector.disconnect();

    expect(await machine.connector.requestToolSync()).toEqual({ outcome: 'not-connected' });
  });

  it('gives the error of a failed read, and keeps the last tool table', async () => {
    const machine = machineThatTakes(100);
    await machine.pollAndSync();
    vi.setSystemTime(Date.now() + 60_000);
    delete machine.replies.TOLNI1;

    const result = await machine.connector.requestToolSync();

    expect(result).toEqual({ outcome: 'failed', toolSync: expect.objectContaining({ error: 'No reply for TOLNI1' }) });
    expect(machine.connector.getStatus().data.toolTable?.[1]).toMatchObject({ length: 1.5 });
    expect(machine.connector.getStatus().errors).toEqual([]);
  });

  it('does not use the connection in a state poll while a tool read runs, and the poll is still good', async () => {
    const machine = machineThatTakes(100);
    machine.held.command = 'TOLNI1';
    const sync = machine.connector.requestToolSync();
    await vi.waitFor(() => expect(machine.held.release).toBeDefined());

    const status = await machine.poll();

    expect(machine.sent).toEqual([]);
    expect(status.connected).toBe(true);
    expect(status.errors).toEqual([]);
    expect(status.data.toolSync?.running).toBe(true);
    machine.held.release!();
    await sync;
  });

  it('refuses a second Sync as busy while the first one waits for the state poll', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;
    machine.held.command = 'PDSP';
    const poll = machine.poll();
    await vi.waitFor(() => expect(machine.held.release).toBeDefined());

    const first = machine.connector.requestToolSync();

    expect(await machine.connector.requestToolSync()).toEqual({ outcome: 'busy' });
    machine.held.release!();
    await poll;
    expect((await first).outcome).toBe('synced');
    expect(machine.sent.filter(command => command === 'ATCTL')).toHaveLength(1);
  });

  it('waits for a state poll that runs before it starts a tool read', async () => {
    const machine = machineThatTakes(100);
    machine.replies.MEM = MEM_RUNNING;
    machine.held.command = 'PDSP';
    const poll = machine.poll();
    await vi.waitFor(() => expect(machine.held.release).toBeDefined());

    const sync = machine.connector.requestToolSync();
    // Each promise that can settle now settles before setImmediate. Then a read that did not wait has sent ATCTL.
    await new Promise(resolve => setImmediate(resolve));
    expect(machine.sent).not.toContain('ATCTL');

    machine.held.release!();
    await poll;
    await sync;
    expect(machine.sent.indexOf('ATCTL')).toBeGreaterThan(machine.sent.indexOf('MCRNI1'));
  });
});

describe('Brother tool sync that does not end', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends with an error after 20 seconds and disconnects, so the next poll connects again', async () => {
    vi.useFakeTimers();
    const connector = connectorWithReplies(MOCK_RESPONSES);
    vi.mocked(connector.sendCommand).mockImplementation(() => new Promise(() => {}));

    let result: unknown;
    void connector.requestToolSync().then(value => { result = value; });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(result).toBeUndefined();
    expect(connector.getStatus().data.toolSync?.running).toBe(true);
    expect(connector.connected).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ outcome: 'failed', toolSync: expect.objectContaining({ error: expect.stringContaining('20 seconds'), running: false }) });
    expect(connector.connected).toBe(false);
  });

  it('ends after 20 seconds also when it waits for a state poll that does not end, so the next poll runs', async () => {
    vi.useFakeTimers();
    const connector = connectorWithReplies(MOCK_RESPONSES);
    vi.mocked(connector.sendCommand).mockImplementation(() => new Promise(() => {}));
    void connector.poll();
    const sync = connector.requestToolSync();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await sync).toEqual({ outcome: 'failed', toolSync: expect.objectContaining({ error: expect.stringContaining('20 seconds'), running: false }) });
    expect(connector.connected).toBe(false);
    vi.mocked(connector.sendCommand).mockClear();
    vi.spyOn(connector, 'connect').mockImplementation(async () => { Object.assign(connector, { socket: { destroy: () => {} }, connected: true }); });
    void connector.poll();
    await vi.waitFor(() => expect(connector.sendCommand).toHaveBeenCalledWith('PANEL'));
  });

  it('does not start the tool read when the state poll ends after the 20 seconds', async () => {
    vi.useFakeTimers();
    const connector = connectorWithReplies(MOCK_RESPONSES);
    const answer = vi.mocked(connector.sendCommand).getMockImplementation()!;
    let releasePanel: () => void = () => {};
    vi.mocked(connector.sendCommand).mockImplementation(async command => {
      if (command === 'PANEL') await new Promise<void>(resolve => { releasePanel = resolve; });
      return answer(command);
    });
    const poll = connector.poll();
    const sync = connector.requestToolSync();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await sync).outcome).toBe('failed');

    releasePanel();
    await poll;
    await vi.advanceTimersByTimeAsync(0);

    expect(sentCommands(connector)).not.toContain('ATCTL');
    expect(sentCommands(connector)).not.toContain('TOLNI1');
  });

  it('does not start the tool read when a newer poll connected again before the old state poll ended', async () => {
    vi.useFakeTimers();
    const connector = connectorWithReplies(MOCK_RESPONSES);
    const answer = vi.mocked(connector.sendCommand).getMockImplementation()!;
    let releaseFirstPanel: () => void = () => {};
    let panels = 0;
    vi.mocked(connector.sendCommand).mockImplementation(async command => {
      if (command === 'PANEL' && ++panels === 1) await new Promise<void>(resolve => { releaseFirstPanel = resolve; });
      return answer(command);
    });
    const oldPoll = connector.poll();
    const sync = connector.requestToolSync();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await sync).outcome).toBe('failed');
    vi.spyOn(connector, 'connect').mockImplementation(async () => { Object.assign(connector, { socket: { destroy: () => {} }, connected: true }); });
    expect((await connector.poll()).connected).toBe(true);

    releaseFirstPanel();
    await oldPoll;
    await vi.advanceTimersByTimeAsync(0);

    expect(sentCommands(connector)).not.toContain('ATCTL');
    expect(sentCommands(connector)).not.toContain('TOLNI1');
  });

  it('keeps a Sync waiting for the poll that runs now when an older poll, which the scheduler left behind, ends', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, MEM: MEM_RUNNING });
    const answer = vi.mocked(connector.sendCommand).getMockImplementation()!;
    const releasePanel: Array<() => void> = [];
    vi.mocked(connector.sendCommand).mockImplementation(async command => {
      if (command === 'PANEL') await new Promise<void>(resolve => { releasePanel.push(resolve); });
      return answer(command);
    });
    const leftBehindPoll = connector.poll();
    const newPoll = connector.poll();
    await vi.waitFor(() => expect(releasePanel).toHaveLength(2));

    releasePanel[0]();
    await leftBehindPoll;
    const sync = connector.requestToolSync();
    await new Promise(resolve => setImmediate(resolve));

    expect(sentCommands(connector)).not.toContain('ATCTL');
    releasePanel[1]();
    await newPoll;
    expect((await sync).outcome).toBe('synced');
    const sent = sentCommands(connector);
    expect(sent.indexOf('ATCTL')).toBeGreaterThan(sent.lastIndexOf('ALARM'));
  });
});

describe('Brother planned reconnect every 60 seconds, with a real TCP connection', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector;
  let log: CapturedLog;
  /** What the machine side saw, in order: "connect 1", "end 1" (an orderly close from Chatter), "connect 2", ... */
  let events: string[];
  /** Each command that the machine got */
  let commands: string[];
  /** The tool in the spindle, in the PDSP reply */
  let spindleTool: number;
  /** Called with each command before the machine answers it */
  let onCommand: (command: string) => void;
  /** A promise that holds back the reply to a command, or null to answer at once */
  let holdReply: (command: string) => Promise<void> | null;

  /** A fake Brother that tells what it sees */
  async function startRecordingBrother(): Promise<void> {
    let connections = 0;
    server = await startServer(socket => {
      const id = ++connections;
      events.push(`connect ${id}`);
      socket.on('end', () => events.push(`end ${id}`));
      socket.on('data', chunk => {
        const command = /CLOD\s+(\S+)/.exec(chunk.toString('ascii'))?.[1] ?? '';
        commands.push(command);
        onCommand(command);
        const reply = command === 'PDSP' ? pdspWithTool(spindleTool) : MOCK_RESPONSES[command];
        const answer = () => socket.write('%' + (reply ?? `RLOD    ${command.padEnd(8)}01\r\n\r\n00%`));
        const held = holdReply(command);
        if (held) void held.then(answer);
        else answer();
      });
    });
    connector = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: portOf(server), timeout: 1000 });
  }

  /** A poll, and then what the connection log of the poller writes for it */
  async function pollAndLog(connectionLog: ConnectionLog) {
    const status = await pollAndSync();
    connectionLog.record(connector);
    return status;
  }

  /** A poll, then the end of the tool sync that it can start */
  async function pollAndSync() {
    const status = await connector.poll();
    await connector.toolSyncEnded();
    return status;
  }

  beforeEach(() => {
    // Only the clock is fake, so the sockets work as usual
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00Z'));
    log = captureLog();
    events = [];
    commands = [];
    spindleTool = 10;
    onCommand = () => {};
    holdReply = () => null;
  });

  afterEach(async () => {
    log.restore();
    vi.useRealTimers();
    connector?.disconnect();
    if (server) await closeServer(server);
    server = null;
  });

  it('closes the connection in order and opens a new one at the first poll after 60 seconds', async () => {
    await startRecordingBrother();
    await pollAndSync();
    vi.setSystemTime(Date.now() + 59_000);
    await pollAndSync();
    expect(events).toEqual(['connect 1']);

    vi.setSystemTime(Date.now() + 1_000);
    const status = await pollAndSync();

    await vi.waitFor(() => expect(events).toEqual(['connect 1', 'end 1', 'connect 2']));
    expect(status.connected).toBe(true);
    expect(status.errors).toEqual([]);
    expect(status.data.partCount).toBe(78);
    expect(BROTHER_RECONNECT_MS).toBe(60_000);
  });

  it('does not show the machine offline, and writes no connection log line for it', async () => {
    await startRecordingBrother();
    const connectionLog = new ConnectionLog();
    await pollAndLog(connectionLog);
    const linesBefore = log.text('info') + log.text('warn');

    vi.setSystemTime(Date.now() + BROTHER_RECONNECT_MS);
    const status = await pollAndLog(connectionLog);
    await pollAndLog(connectionLog);

    expect(status.connected).toBe(true);
    expect(log.text('info') + log.text('warn')).toBe(linesBefore);
    expect(log.text('debug')).toMatch(/Planned reconnect.*machine=b1/);
  });

  it('counts the planned reconnects in the poll times', async () => {
    await startRecordingBrother();
    await pollAndSync();

    vi.setSystemTime(Date.now() + BROTHER_RECONNECT_MS);
    const status = await pollAndSync();

    expect(status.pollTimings?.plannedReconnects).toEqual({ count: 1, lastAt: new Date(Date.now()).toISOString() });
  });

  it.each([
    ['Chatter disconnects', (brother: BrotherConnector) => brother.disconnect()],
    ['the user removes the machine', (brother: BrotherConnector) => brother.dispose()],
  ])('ends a tool read with the reason when %s during it, clears its 20 s timer, and the next poll connects again', async (_, close) => {
    await startRecordingBrother();
    await pollAndSync();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    holdReply = command => command === 'TOLNI1' ? new Promise<void>(() => {}) : null;
    const sync = connector.requestToolSync();
    await vi.waitFor(() => expect(commands.filter(command => command === 'TOLNI1')).toHaveLength(2));

    close(connector);
    const result = await sync;

    expect(result).toEqual({
      outcome: 'failed',
      toolSync: expect.objectContaining({ error: 'The connection closed before the machine answered', running: false }),
    });
    const timerCall = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === TOOL_SYNC_TIMEOUT_MS);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[timerCall].value);
    holdReply = () => null;
    const status = await connector.poll();
    expect(status.connected).toBe(true);
    expect(status.errors).toEqual([]);
    expect(events).toEqual(expect.arrayContaining(['connect 2']));
  });

  it('ends a Sync that waits for the state poll with the reason when the user removes the machine, and clears its 20 s timer', async () => {
    await startRecordingBrother();
    await pollAndSync();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    holdReply = command => command === 'PDSP' ? new Promise<void>(() => {}) : null;
    commands.length = 0;
    const poll = connector.poll();
    await vi.waitFor(() => expect(commands).toContain('PDSP'));
    const sync = connector.requestToolSync();

    connector.dispose();

    const result = await sync;
    expect(result).toEqual({
      outcome: 'failed',
      toolSync: expect.objectContaining({ error: expect.stringContaining('The connection closed before the machine answered'), running: false }),
    });
    const timerCall = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === TOOL_SYNC_TIMEOUT_MS);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[timerCall].value);
    expect(commands).not.toContain('ATCTL');
    await poll;
  });

  it('does not reconnect while a tool read runs', async () => {
    await startRecordingBrother();
    await pollAndSync();
    vi.setSystemTime(Date.now() + BROTHER_RECONNECT_MS);
    let releaseToolData: (() => void) | undefined;
    holdReply = command => command === 'TOLNI1' ? new Promise<void>(resolve => { releaseToolData = resolve; }) : null;
    const sync = connector.requestToolSync();
    await vi.waitFor(() => expect(releaseToolData).toBeDefined());

    const status = await connector.poll();

    expect(status.connected).toBe(true);
    expect(events).toEqual(['connect 1']);
    releaseToolData!();
    expect((await sync).outcome).toBe('synced');
  });

  it('does not stop a poll that runs at the 60 s mark, and reconnects at the next poll', async () => {
    await startRecordingBrother();
    await pollAndSync();
    vi.setSystemTime(Date.now() + 59_000);
    onCommand = command => { if (command === 'MEM') vi.setSystemTime(Date.now() + 2_000); };

    const status = await pollAndSync();

    expect(status.errors).toEqual([]);
    expect(events).toEqual(['connect 1']);
    onCommand = () => {};
    await pollAndSync();
    await vi.waitFor(() => expect(events).toEqual(['connect 1', 'end 1', 'connect 2']));
  });
});

describe('Brother planned reconnect when the control does not close its side', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector | undefined;
  const machineSides: net.Socket[] = [];
  let log: CapturedLog;

  beforeEach(() => {
    log = captureLog();
  });

  afterEach(async () => {
    log.restore();
    vi.useRealTimers();
    connector?.disconnect();
    machineSides.forEach(socket => socket.destroy());
    machineSides.length = 0;
    await new Promise(resolve => (server?.listening ? server.close(resolve) : resolve(undefined)));
    server = null;
  });

  /**
   * A fake Brother that gets the FIN of Chatter and keeps its own side open (allowHalfOpen), so the orderly close
   * waits its full 2 s. Gives a connector after its first poll, 60 s later, so its next poll makes the planned reconnect.
   */
  async function brotherThatKeepsItsSideOpen(): Promise<BrotherConnector> {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00Z'));
    server = net.createServer({ allowHalfOpen: true }, socket => {
      machineSides.push(socket);
      socket.on('error', () => {});
      answerLikeABrother(socket);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const brother = newConnector({ id: 'b1', host: '127.0.0.1', dataPort: portOf(server), timeout: 1000 });
    connector = brother;
    await brother.poll();
    await brother.toolSyncEnded();
    vi.setSystemTime(Date.now() + BROTHER_RECONNECT_MS);
    return brother;
  }

  it('destroys the old connection after 2 s, and the poll ends connected on a new connection', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const oldSocket = Reflect.get(brother, 'socket') as net.Socket;
    let status: BrotherMachineStatus | undefined;
    const poll = brother.poll().then(result => { status = result; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(status).toBeUndefined();
    expect(machineSides).toHaveLength(1);
    // Chatter still waits for the control to close its side
    expect(oldSocket.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(oldSocket.destroyed).toBe(true);
    await poll;

    expect(machineSides).toHaveLength(2);
    expect(status?.connected).toBe(true);
    expect(status?.errors).toEqual([]);
    expect(status?.data.partCount).toBe(78);
  });

  it('shows the machine online in each status and writes no log line while it waits for the orderly close', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const poller = new HardwarePoller(new Database(':memory:'));
    (Reflect.get(poller, 'registry') as MachineRegistry).add(brother);
    const connectionLog = new ConnectionLog();
    connectionLog.record(brother);
    const poll = brother.poll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(brother.getStatus().connected).toBe(true);
    // The poller sends this status to the screens after the poll of each machine, also of another machine
    expect(poller.getStatus().find(machine => machine.id === 'b1')).toMatchObject({ connected: true });
    connectionLog.record(brother);

    await vi.advanceTimersByTimeAsync(1000);
    await poll;
    expect(brother.getStatus().connected).toBe(true);
    expect(log.text('warn')).not.toContain('offline');
    // The reconnect has ended: when the control closes the new connection, the status shows the machine offline
    machineSides.at(-1)!.destroy();
    await vi.waitFor(() => expect(brother.getStatus().connected).toBe(false));
  });

  it('shows the machine offline with the reason when the new connect fails', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const connectionLog = new ConnectionLog();
    connectionLog.record(brother);
    const poll = brother.poll();
    // The control is gone: it takes no new connection
    server!.close();

    await vi.advanceTimersByTimeAsync(2000);
    const status = await poll;

    // Also shows that the reconnect has ended: during it, the status says connected
    expect(status.connected).toBe(false);
    expect(status.errors.join('; ')).toContain('Unable to connect');
    connectionLog.record(brother);
    expect(log.text('warn')).toMatch(/Machine went offline.*Unable to connect/);
  });

  it('ends a Sync during a reconnect that fails with the reason of the connect', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const poll = brother.poll();
    server!.close();
    const sync = brother.requestToolSync();

    await vi.advanceTimersByTimeAsync(2000);
    await poll;

    expect(await sync).toEqual({
      outcome: 'failed', toolSync: expect.objectContaining({ error: expect.stringContaining('Unable to connect'), running: false }),
    });
  });

  it.each([
    ['disconnects it', (brother: BrotherConnector) => brother.disconnect()],
    ['removes it', (brother: BrotherConnector) => brother.dispose()],
  ])('shows the machine offline at once when Chatter %s during the reconnect, and opens no new connection', async (_, close) => {
    const brother = await brotherThatKeepsItsSideOpen();
    const poll = brother.poll();
    await vi.advanceTimersByTimeAsync(1000);

    close(brother);

    expect(brother.getStatus().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const status = await poll;
    expect(status.connected).toBe(false);
    expect(brother.getStatus().connected).toBe(false);
    // The scheduler polls a removed machine no more, so a new connection would hold the one client slot of the control
    expect(machineSides).toHaveLength(1);
  });

  it('ends a Sync that waits for the reconnect with the reason when Chatter removes the machine, and reads no tools', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const lastSyncAt = brother.getStatus().data.toolSync?.lastSyncAt;
    const poll = brother.poll();
    await vi.advanceTimersByTimeAsync(1000);
    const sync = brother.requestToolSync();

    brother.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await poll;

    expect(await sync).toEqual({
      outcome: 'failed',
      toolSync: expect.objectContaining({ error: 'Unable to connect: The connection closed before it opened', lastSyncAt, running: false }),
    });
    expect(machineSides).toHaveLength(1);
  });

  it('reads the tools after the reconnect when a user presses Sync during it', async () => {
    const brother = await brotherThatKeepsItsSideOpen();
    const poll = brother.poll();
    await vi.advanceTimersByTimeAsync(1000);

    const sync = brother.requestToolSync();
    await vi.advanceTimersByTimeAsync(1000);
    await poll;

    expect(await sync).toEqual({ outcome: 'synced', toolSync: expect.objectContaining({ error: null, running: false }) });
    expect(machineSides).toHaveLength(2);
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

/** Sync the tools `count` times, 30 s apart (the Sync limit), and connect again before each one */
async function syncWithReconnects(connector: BrotherConnector, count: number) {
  connectWithNoSocket(connector);
  for (let i = 0; i < count; i++) {
    connector.disconnect();
    await connector.poll();
    await connector.toolSyncEnded();
    await connector.requestToolSync();
    vi.setSystemTime(Date.now() + 30_000);
  }
}

/** Only the clock is fake, so the 30 s Sync limit can pass at once */
function useFakeClock() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

describe('Brother control type, found once by the reply status', () => {
  useFakeClock();

  it('never sends ATCTLD to a C00 control, across reconnects and tool syncs', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTLD: UNKNOWN_ATCTLD });

    await syncWithReconnects(connector, 3);

    expect(sentCommands(connector)).not.toContain('ATCTLD');
    expect(sentCommands(connector).filter(command => command === 'ATCTL').length).toBeGreaterThanOrEqual(3);
    expect(connector.getStatus().data.controlType).toBe('C00');
  });

  it('is a C00 control when ATCTL answers with status 00 and no pots, and does not try ATCTLD', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: 'RLOD    ATCTL   00\r\n\r\n00%', ATCTLD: UNKNOWN_ATCTLD });

    await connector.requestToolSync();

    expect(connector.getStatus().data.controlType).toBe('C00');
    expect(sentCommands(connector)).not.toContain('ATCTLD');
  });

  it('on a D00 control, sends ATCTL one time only, and then ATCTLD', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: D00_ATCTLD });

    await syncWithReconnects(connector, 3);

    expect(sentCommands(connector).filter(command => command === 'ATCTL')).toHaveLength(1);
    expect(sentCommands(connector).filter(command => command === 'ATCTLD').length).toBeGreaterThanOrEqual(3);
    expect(connector.getStatus().data.controlType).toBe('D00');
    expect(connector.getStatus().data.toolTable?.[1]).toMatchObject({ toolNum: 1 });
  });

  it('asks no ATC command again when the control knows neither, and still reads the tool data', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: UNKNOWN_ATCTLD });

    await syncWithReconnects(connector, 3);

    expect(sentCommands(connector).filter(command => command.startsWith('ATCTL'))).toEqual(['ATCTL', 'ATCTLD']);
    expect(connector.getStatus().data.controlType).toBeNull();
    expect(sentCommands(connector).filter(command => command === 'TOLNI1').length).toBeGreaterThanOrEqual(3);
  });

  it('sends no macro command when no macro is set', async () => {
    const connector = connectorWithReplies(MOCK_RESPONSES);

    await connector.poll();
    await connector.toolSyncEnded();

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
  useFakeClock();

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

    const failed = await connector.requestToolSync();
    vi.setSystemTime(Date.now() + 30_000);
    await syncWithReconnects(connector, 1);

    expect(failed.outcome).toBe('failed');
    expect(sentCommands(connector)).not.toContain('ATCTLD');
    expect(connector.getStatus().data.controlType).toBe('C00');
    expect(connector.getStatus().data.hasPocketInfo).toBe(true);
  });

  it('on a D00, finds D00 later when ATCTLD gets "Not connected", and does not send ATCTL again', async () => {
    const connector = connectorWithReplies({ ...MOCK_RESPONSES, ATCTL: UNKNOWN_ATCTL, ATCTLD: D00_ATCTLD });
    connectWithNoSocket(connector);
    failFirstSend(connector, 'ATCTLD', () => new Error('Not connected'));

    const failed = await connector.requestToolSync();
    vi.setSystemTime(Date.now() + 30_000);
    await syncWithReconnects(connector, 2);

    expect(failed.outcome).toBe('failed');
    expect(sentCommands(connector).filter(command => command === 'ATCTL')).toHaveLength(1);
    expect(connector.getStatus().data.controlType).toBe('D00');
    expect(connector.getStatus().data.hasPocketInfo).toBe(true);
    expect(connector.getStatus().data.toolTable?.[1]).toMatchObject({ toolNum: 1 });
  });
});

describe('Brother control type when the machine does not answer ATCTL, with a real TCP connection', () => {
  let server: net.Server | null = null;
  let connector: BrotherConnector | undefined;

  useFakeClock();

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

    await connector.poll();
    await connector.toolSyncEnded();
    const first = connector.getStatus().data.toolSync;
    vi.setSystemTime(Date.now() + 30_000);
    await connector.poll();
    await connector.toolSyncEnded();

    expect(first?.error).toBe(NO_REPLY_ERROR);
    expect(connector.getStatus().errors).toEqual([]);
    expect(connector.getStatus().data.controlType).toBe('C00');
    expect(commands).not.toContain('ATCTLD');
    expect(commands.filter(sent => sent === 'ATCTL')).toHaveLength(2);
  });
});
