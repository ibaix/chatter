/**
 * The messages between the server and the FOCAS thread, and how the FOCAS thread answers them.
 * Nothing here needs a thread, so the tests run it directly.
 */

import type { Focas, FocasAlarm, FocasProgramWithPath, FocasSpindle, FocasStatus } from './focas.js';
import { FocasError, isConnectionLost } from './focasError.js';

/** The path that Chatter reads mode, program, tool and part count from, and that a connection is left on */
export const MAIN_PATH = 1;

/** The reads of readPath that may fail. A failed one is in failedReads, by this name. */
export const OPTIONAL_PATH_READS = ['program', 'program path', 'spindles', 'alarms'] as const;
export type OptionalPathRead = typeof OPTIONAL_PATH_READS[number];

/** A read of readPath that failed, so the server can log it. The other reads of the path still count. */
export interface FailedPathRead {
  read: OptionalPathRead;
  message: string;
  code?: number;
}

/** The values of one path of a multi-path control, from one readPath request */
export interface FocasPathValues {
  path: number;
  status: FocasStatus;
  /** Undefined when the read failed */
  program?: FocasProgramWithPath;
  /** Undefined when the read failed */
  spindles?: FocasSpindle[];
  /** Undefined when the read failed */
  alarms?: FocasAlarm[];
  failedReads: FailedPathRead[];
}

/** The reads of one connection that the server can ask for */
export type FocasRead =
  | 'readStatus'
  | 'readSpindleSpeed'
  | 'readSpindleLoad'
  | 'readMacro'
  | 'readProgram'
  | 'readAlarms'
  | 'readOperatorMessages'
  | 'readSystemInfo'
  | 'readPathCount'
  /** The values of one path: readPath(path, pathCount) (see readPath below) */
  | 'readPath';

export type FocasCommand =
  | { kind: 'initialize'; libraryPath: string; startProcess: boolean }
  | { kind: 'connect'; host: string; port: number; timeoutSeconds: number }
  | { kind: 'disconnect'; session: number }
  | { kind: 'read'; session: number; read: FocasRead; args: number[] }
  /** End every connection and unload the library, when the server shuts down */
  | { kind: 'cleanup'; exitProcess: boolean };

export type FocasRequest = FocasCommand & { id: number };

export type FocasResponse =
  | { id: number; ok: true; value: unknown }
  /** code is the FOCAS return code, when the failure came from a cnc_* call */
  | { id: number; ok: false; message: string; code?: number };

/** One connection to a control, as the Focas class gives it */
export type FocasConnection = Pick<
  Focas,
  Exclude<FocasRead, 'readPath'> | 'disconnect' | 'selectPath' | 'readSpindles' | 'readProgramPath'
>;

/**
 * Read one path of a control: select it (cnc_setpath), read its status, program, spindles and alarms,
 * and select the main path again. It runs on the FOCAS thread as one request, so no other call of the
 * connection can run between the path change and the reads.
 *
 * A control with one path gets no cnc_setpath call. The status must be read, or the request fails, and
 * so does a failed cnc_setpath (with its FOCAS return code). The other reads may fail: each failure is in
 * failedReads, and its value is left out. A lost connection (EW_SOCKET, EW_HANDLE) fails the request at once.
 */
export function readPath(connection: FocasConnection, path: number, pathCount: number): FocasPathValues {
  const multiPath = pathCount > 1;
  if (multiPath) connection.selectPath(path);
  let values: FocasPathValues;
  try {
    const failedReads: FailedPathRead[] = [];
    const optional = <T>(read: OptionalPathRead, run: () => T): T | undefined => {
      try {
        return run();
      } catch (error) {
        if (isConnectionLost(error)) throw error;
        failedReads.push({
          read,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof FocasError ? { code: error.code } : {}),
        });
        return undefined;
      }
    };

    const status = connection.readStatus();
    const program = optional('program', () => connection.readProgram());
    const fullPath = program ? optional('program path', () => connection.readProgramPath()) : undefined;
    values = {
      path,
      status,
      program: program && { ...program, ...(fullPath ? { fullPath } : {}) },
      spindles: optional('spindles', () => connection.readSpindles()),
      alarms: optional('alarms', () => connection.readAlarms()),
      failedReads,
    };
  } catch (error) {
    // The reads failed, so their error counts. The main path is selected again when the connection still works.
    if (multiPath && path !== MAIN_PATH && !isConnectionLost(error)) {
      try { connection.selectPath(MAIN_PATH); } catch { /* the error of the reads is the one to give */ }
    }
    throw error;
  }
  if (multiPath && path !== MAIN_PATH) connection.selectPath(MAIN_PATH);
  return values;
}

/** The parts of the FOCAS library that the FOCAS thread uses */
export interface FocasLibrary {
  /** Load the library. On Linux, startProcess also calls cnc_startupprocess, which only one thread of the server may do. */
  initialize(libraryPath: string, startProcess: boolean): void;
  connect(host: string, port: number, timeoutSeconds: number): FocasConnection;
  /** Unload the library. On Linux, exitProcess also calls cnc_exitprocess, which only the last thread may do. */
  cleanup(exitProcess: boolean): void;
}

const READS: ReadonlySet<string> = new Set<FocasRead>([
  'readStatus',
  'readSpindleSpeed',
  'readSpindleLoad',
  'readMacro',
  'readProgram',
  'readAlarms',
  'readOperatorMessages',
  'readSystemInfo',
  'readPathCount',
  'readPath',
]);

/**
 * Answers the requests of the server, one at a time, on the FOCAS thread.
 * Each connection gets a number (a session), which the server sends with each read.
 */
export class FocasRequestHandler {
  private readonly connections = new Map<number, FocasConnection>();
  private nextSession = 1;

  constructor(private readonly library: FocasLibrary) {}

  handle(request: FocasRequest): FocasResponse {
    try {
      return { id: request.id, ok: true, value: this.run(request) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof FocasError) return { id: request.id, ok: false, message, code: error.code };
      return { id: request.id, ok: false, message };
    }
  }

  private run(command: FocasCommand): unknown {
    switch (command.kind) {
      case 'initialize':
        this.library.initialize(command.libraryPath, command.startProcess);
        return undefined;
      case 'connect': {
        const connection = this.library.connect(command.host, command.port, command.timeoutSeconds);
        const session = this.nextSession++;
        this.connections.set(session, connection);
        return session;
      }
      case 'disconnect': {
        const connection = this.connections.get(command.session);
        this.connections.delete(command.session);
        connection?.disconnect();
        return undefined;
      }
      case 'read':
        return this.read(command.session, command.read, command.args);
      case 'cleanup':
        this.cleanup(command.exitProcess);
        return undefined;
    }
  }

  /** Free the handle of each connection (cnc_freelibhndl) before the library goes */
  private cleanup(exitProcess: boolean): void {
    for (const connection of this.connections.values()) {
      try {
        connection.disconnect();
      } catch {
        // The server shuts down, so the other handles and the library still go
      }
    }
    this.connections.clear();
    this.library.cleanup(exitProcess);
  }

  private read(session: number, read: FocasRead, args: number[]): unknown {
    if (!READS.has(read)) throw new Error(`Unknown FOCAS read: ${read}`);
    const connection = this.connections.get(session);
    if (!connection) throw new Error('Not connected to CNC controller');
    if (read === 'readPath') return readPath(connection, args[0], args[1]);
    const call = connection[read] as (...values: number[]) => unknown;
    return call.apply(connection, args);
  }
}
