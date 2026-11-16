import { describe, expect, it, vi } from 'vitest';
import { FocasRequestHandler, readPath, type FocasConnection, type FocasLibrary } from './focasRequests.js';
import { EW_HANDLE, EW_SOCKET, FocasError } from './focasError.js';

function fakeConnection(name: string): FocasConnection {
  return {
    disconnect: vi.fn(),
    readStatus: vi.fn(() => ({ mode: name } as ReturnType<FocasConnection['readStatus']>)),
    readSpindleSpeed: vi.fn(() => ({ speed: 1200 })),
    readSpindleLoad: vi.fn(() => undefined),
    readMacro: vi.fn((number: number) => ({ number, value: 7, decimalPlaces: 0 })),
    readProgram: vi.fn(() => ({ name: 'O1', number: 1 })),
    readAlarms: vi.fn(() => []),
    readOperatorMessages: vi.fn(() => []),
    readSystemInfo: vi.fn(() => ({ cncType: '31', mtType: 'M', series: 'G421', version: '0010', maxAxes: 32 })),
    readPathCount: vi.fn(() => ({ path: 1, maxPath: 1 })),
    selectPath: vi.fn(),
    readSpindles: vi.fn(() => [{ name: 'S1', speed: 1200, load: 3 }]),
    readProgramPath: vi.fn(() => '//CNC_MEM/USER/PATH1/O1'),
  };
}

function handlerWith(connections: FocasConnection[]) {
  const library: FocasLibrary = {
    initialize: vi.fn(),
    cleanup: vi.fn(),
    connect: vi.fn(() => {
      const next = connections.shift();
      if (!next) throw new Error('Connection failed: Socket error');
      return next;
    }),
  };
  return { library, handler: new FocasRequestHandler(library) };
}

describe('FocasRequestHandler', () => {
  it('loads the library from the path that the server sends', () => {
    const { library, handler } = handlerWith([]);
    expect(handler.handle({ id: 1, kind: 'initialize', libraryPath: '/data/focas/lib.so', startProcess: true })).toEqual({ id: 1, ok: true, value: undefined });
    expect(library.initialize).toHaveBeenCalledWith('/data/focas/lib.so', true);
  });

  it('gives each connection its own session, and reads from that connection', () => {
    const { library, handler } = handlerWith([fakeConnection('A'), fakeConnection('B')]);
    const first = handler.handle({ id: 1, kind: 'connect', host: '10.0.0.1', port: 8193, timeoutSeconds: 10 });
    const second = handler.handle({ id: 2, kind: 'connect', host: '10.0.0.2', port: 8193, timeoutSeconds: 10 });
    expect(library.connect).toHaveBeenCalledWith('10.0.0.1', 8193, 10);
    expect(first).toEqual({ id: 1, ok: true, value: 1 });
    expect(second).toEqual({ id: 2, ok: true, value: 2 });

    expect(handler.handle({ id: 3, kind: 'read', session: 2, read: 'readStatus', args: [] }))
      .toEqual({ id: 3, ok: true, value: { mode: 'B' } });
  });

  it('passes the arguments of a read', () => {
    const { handler } = handlerWith([fakeConnection('A')]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });
    expect(handler.handle({ id: 2, kind: 'read', session: 1, read: 'readMacro', args: [500] }))
      .toEqual({ id: 2, ok: true, value: { number: 500, value: 7, decimalPlaces: 0 } });
  });

  it('answers a failure with its message, and keeps answering', () => {
    const { handler } = handlerWith([]);
    expect(handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 }))
      .toEqual({ id: 1, ok: false, message: 'Connection failed: Socket error' });
    expect(handler.handle({ id: 2, kind: 'initialize', libraryPath: 'x', startProcess: false }).ok).toBe(true);
  });

  it('answers a failed cnc_* call with its FOCAS return code', () => {
    const connection = fakeConnection('A');
    vi.mocked(connection.readStatus).mockImplementation(() => { throw new FocasError('Failed to read status: Socket error', EW_SOCKET); });
    const { handler } = handlerWith([connection]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });

    expect(handler.handle({ id: 2, kind: 'read', session: 1, read: 'readStatus', args: [] }))
      .toEqual({ id: 2, ok: false, message: 'Failed to read status: Socket error', code: EW_SOCKET });
  });

  it('ends a connection, after which its session cannot read', () => {
    const connection = fakeConnection('A');
    const { handler } = handlerWith([connection]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });

    expect(handler.handle({ id: 2, kind: 'disconnect', session: 1 }).ok).toBe(true);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(handler.handle({ id: 3, kind: 'read', session: 1, read: 'readStatus', args: [] }))
      .toEqual({ id: 3, ok: false, message: 'Not connected to CNC controller' });
  });

  it('frees every connection and then unloads the library at cleanup', () => {
    const first = fakeConnection('A');
    const second = fakeConnection('B');
    const { library, handler } = handlerWith([first, second]);
    handler.handle({ id: 1, kind: 'connect', host: 'a', port: 1, timeoutSeconds: 1 });
    handler.handle({ id: 2, kind: 'connect', host: 'b', port: 1, timeoutSeconds: 1 });
    vi.mocked(first.disconnect).mockImplementation(() => { throw new Error('Socket error'); });

    expect(handler.handle({ id: 3, kind: 'cleanup', exitProcess: true }).ok).toBe(true);

    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(library.cleanup).toHaveBeenCalledWith(true);
    expect(handler.handle({ id: 4, kind: 'read', session: 2, read: 'readStatus', args: [] }).ok).toBe(false);
  });

  it('refuses a read that is not a FOCAS read', () => {
    const { handler } = handlerWith([fakeConnection('A')]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });
    const response = handler.handle({ id: 2, kind: 'read', session: 1, read: 'disconnect' as never, args: [] });
    expect(response).toEqual({ id: 2, ok: false, message: 'Unknown FOCAS read: disconnect' });
  });
});

/** EW_FUNC: the control does not have the function */
const EW_FUNC = 1;
/** EW_PATH: the control has no such path */
const EW_PATH = 11;

/**
 * A FANUC 0i-TT, with the values probed on one: path 1 is the turret with S1 (main) and S2 (milling spindle)
 * and runs O6000, path 2 is the sub-spindle S3. It records which path each call went to.
 */
function twoPathLathe() {
  let selected = 1;
  const calls: string[] = [];
  const onPath = <T>(name: string, values: Record<number, T>) => vi.fn((): T => {
    calls.push(`${name}@${selected}`);
    return values[selected];
  });
  const status = (runState: string) => ({ mode: 'MEMORY', runState, emergency: false, alarm: false }) as ReturnType<FocasConnection['readStatus']>;
  const connection = {
    ...fakeConnection('0i-TT'),
    selectPath: vi.fn((path: number) => {
      calls.push(`setpath(${path})`);
      selected = path;
    }),
    readStatus: onPath('statinfo', { 1: status('START'), 2: status('RESET') }),
    readProgram: onPath('exeprgname', { 1: { name: 'O6000', number: 6000 }, 2: { name: 'O5000', number: 5000 } }),
    readProgramPath: onPath('exeprgname2', { 1: '//DATA_SV/O6000', 2: '//DATA_SV/O5000' }),
    readSpindles: onPath('spindles', {
      1: [{ name: 'S1', speed: 0, load: 0 }, { name: 'S2', speed: 0, load: 0 }],
      2: [{ name: 'S3', speed: 500, load: 3 }],
    }),
    readAlarms: onPath('alarms', { 1: [], 2: [] }),
  } satisfies FocasConnection;
  return { connection, calls, selected: () => selected };
}

describe('readPath', () => {
  it('selects the path, reads it, and selects path 1 again', () => {
    const lathe = twoPathLathe();

    const values = readPath(lathe.connection, 2, 2);

    expect(values).toEqual({
      path: 2,
      status: expect.objectContaining({ runState: 'RESET' }),
      program: { name: 'O5000', number: 5000, fullPath: '//DATA_SV/O5000' },
      spindles: [{ name: 'S3', speed: 500, load: 3 }],
      alarms: [],
      failedReads: [],
    });
    expect(lathe.calls).toEqual([
      'setpath(2)', 'statinfo@2', 'exeprgname@2', 'exeprgname2@2', 'spindles@2', 'alarms@2', 'setpath(1)',
    ]);
    expect(lathe.selected()).toBe(1);
  });

  it('selects path 1 before it reads path 1, and no other path', () => {
    const lathe = twoPathLathe();

    expect(readPath(lathe.connection, 1, 2).program?.fullPath).toBe('//DATA_SV/O6000');
    expect(lathe.calls[0]).toBe('setpath(1)');
    expect(lathe.calls.filter(call => call.startsWith('setpath'))).toEqual(['setpath(1)']);
  });

  it('makes no cnc_setpath call on a control with one path', () => {
    const lathe = twoPathLathe();

    readPath(lathe.connection, 1, 1);

    expect(lathe.connection.selectPath).not.toHaveBeenCalled();
  });

  it('fails with the FOCAS return code when the path cannot be selected, and reads nothing', () => {
    const lathe = twoPathLathe();
    lathe.connection.selectPath.mockImplementationOnce(() => { throw new FocasError('Failed to select path 2: Path error', EW_PATH); });

    expect(() => readPath(lathe.connection, 2, 2)).toThrow(expect.objectContaining({ code: EW_PATH }));
    expect(lathe.connection.readStatus).not.toHaveBeenCalled();
  });

  it('answers a failed cnc_setpath through the handler with its FOCAS return code', () => {
    const lathe = twoPathLathe();
    lathe.connection.selectPath.mockImplementationOnce(() => { throw new FocasError('Failed to select path 2: Path error', EW_PATH); });
    const { handler } = handlerWith([lathe.connection]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });

    expect(handler.handle({ id: 2, kind: 'read', session: 1, read: 'readPath', args: [2, 2] }))
      .toEqual({ id: 2, ok: false, message: 'Failed to select path 2: Path error', code: EW_PATH });
  });

  it('runs the whole path read as one request of the handler', () => {
    const lathe = twoPathLathe();
    const { handler } = handlerWith([lathe.connection]);
    handler.handle({ id: 1, kind: 'connect', host: 'h', port: 1, timeoutSeconds: 1 });

    const response = handler.handle({ id: 2, kind: 'read', session: 1, read: 'readPath', args: [2, 2] });

    expect(response).toMatchObject({ id: 2, ok: true, value: { path: 2, spindles: [{ name: 'S3', speed: 500, load: 3 }] } });
    expect(lathe.selected()).toBe(1);
  });

  it('leaves out a value that the control does not give, and says which read failed', () => {
    const lathe = twoPathLathe();
    lathe.connection.readProgramPath.mockImplementation(() => { throw new FocasError('Failed to read program path: Command prepare error', EW_FUNC); });

    const values = readPath(lathe.connection, 2, 2);

    expect(values.program).toEqual({ name: 'O5000', number: 5000 });
    expect(values.spindles).toHaveLength(1);
    expect(values.failedReads).toEqual([{ read: 'program path', message: 'Failed to read program path: Command prepare error', code: EW_FUNC }]);
    expect(lathe.selected()).toBe(1);
  });

  it('does not read the full program name when the program cannot be read', () => {
    const lathe = twoPathLathe();
    lathe.connection.readProgram.mockImplementation(() => { throw new FocasError('Failed to read program: Data error', 5); });
    lathe.connection.readAlarms.mockImplementation(() => { throw new Error('Failed to read alarms'); });

    const values = readPath(lathe.connection, 2, 2);

    expect(values.program).toBeUndefined();
    expect(values.alarms).toBeUndefined();
    expect(lathe.connection.readProgramPath).not.toHaveBeenCalled();
    expect(values.failedReads.map(failed => failed.read)).toEqual(['program', 'alarms']);
    expect(values.failedReads[1]).not.toHaveProperty('code');
    expect(lathe.calls.at(-1)).toBe('setpath(1)');
  });

  it('fails when the status cannot be read, and still selects path 1 again', () => {
    const lathe = twoPathLathe();
    lathe.connection.readStatus.mockImplementation(() => { throw new FocasError('Failed to read status: Busy', -1); });

    expect(() => readPath(lathe.connection, 2, 2)).toThrow('Failed to read status');
    expect(lathe.selected()).toBe(1);
  });

  it('fails at once on a lost connection, with no more calls', () => {
    const lathe = twoPathLathe();
    lathe.connection.readSpindles.mockImplementation(() => { throw new FocasError('Failed to read spindle meters: Handle error', EW_HANDLE); });

    expect(() => readPath(lathe.connection, 2, 2)).toThrow(expect.objectContaining({ code: EW_HANDLE }));
    expect(lathe.connection.readAlarms).not.toHaveBeenCalled();
    // Not even the change back to path 1, which would only wait out the timeout of the lost connection
    expect(lathe.calls.at(-1)).toBe('exeprgname2@2');
  });

  it('fails when path 1 cannot be selected again, so no later read goes to the wrong path', () => {
    const lathe = twoPathLathe();
    lathe.connection.selectPath
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new FocasError('Failed to select path 1: Path error', EW_PATH); });

    expect(() => readPath(lathe.connection, 2, 2)).toThrow('Failed to select path 1');
  });
});
