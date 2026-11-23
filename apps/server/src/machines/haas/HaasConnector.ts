import net from 'net';
import { tuneMachineSocket } from '../machineSocket.js';
import { BaseMachineConnector, errorMessage } from '../BaseMachineConnector.js';
import type {
  HaasMachineConfig,
  HaasMachineStatus,
  HaasMachineData,
  MachineType,
  MacroConfig,
  MachineDataSnapshot,
} from '../../types/index.js';
import { createLogger } from '../../logging/logger.js';
import { ReplyTooLargeError, warnReplyTooLarge } from '../replyLimit.js';

const log = createLogger('haas');

const DEFAULT_DATA_PORT = 9998;
const DEFAULT_QUERY_PORT = 5051;

// Protocol constants
const DATA_STREAM_INIT = 'M_T_C_O_N_N_E_C_T_O_N\r\n';
const DATA_STREAM_DISCONNECT = 'M_T_C_O_N_N_E_C_T_O_F_F\r\n';
const DATA_DELIMITER = Buffer.from([0x0A, 0x03, 0x02]); // \n\x03\x02

/**
 * The longest data stream line that Chatter keeps while it waits for the delimiter. A line holds some key|value
 * pairs. Nobody has seen the stream of a real Haas yet, so the limit has a wide margin. An endless line must stop,
 * because a Pi can have 512 MB of RAM.
 */
export const MAX_HAAS_LINE_BYTES = 1024 * 1024;
/** The longest query reply. A reply is one short line, such as ">MACRO, 123.456". */
export const MAX_HAAS_QUERY_REPLY_BYTES = 64 * 1024;

/** A query with no reply in this time gets no value */
const QUERY_REPLY_TIMEOUT_MS = 2000;
/** Each query adds listeners to the query socket for a short time */
const MAX_QUERY_SOCKET_LISTENERS = 50;
/** Haas sends the spindle RPM with 4 decimal places as an integer (e.g., 4999328 = 499.9328 RPM) */
const SPINDLE_RPM_SCALE = 10000;

// Haas alarm code lookup table
const HAAS_ALARM_CODES: Record<string, string> = {
  '107': 'EMERGENCY STOP',
  '108': 'X SERVO OVERLOAD',
  '109': 'Y SERVO OVERLOAD',
  '110': 'Z SERVO OVERLOAD',
  '111': 'A SERVO OVERLOAD',
  '188': 'B SERVO OVERLOAD',
  '271': 'C SERVO OVERLOAD',
  '674': 'TT SERVO OVERLOAD',
  '1.108': 'X AXIS SERVO OVERLOAD',
  '2.108': 'Y AXIS SERVO OVERLOAD',
  '3.108': 'Z AXIS SERVO OVERLOAD',
  '5.108': 'A AXIS SERVO OVERLOAD',
  '6.108': 'B AXIS SERVO OVERLOAD',
  '7.108': 'C AXIS SERVO OVERLOAD',
  '11.108': 'TA AXIS SERVO OVERLOAD',
};

/**
 * The text of a Haas alarm code, from the local table, because the machine does not send alarm texts.
 * An unknown code gives undefined.
 */
export function haasAlarmText(code: string): string | undefined {
  return HAAS_ALARM_CODES[code];
}

// Data stream field mappings - maps Haas data stream keys to normalized MachineData fields
const DATA_STREAM_FIELDS: Record<string, keyof HaasMachineData> = {
  'ActiveTool': 'toolNumber',
  'ProgramName': 'program',
  'SpindleActualRPM': 'spindleSpeed',
  'alarm0': 'alarmCode',
};

/**
 * Command for querying Haas machine via query port
 */
export interface HaasCommand {
  queryStart: string;      // e.g., 'Q600' for macros, 'Q104' for mode
  macroLocation?: number;  // macro variable location (for Q600)
  label: string;           // label for the data (e.g., 'Mode', 'Macro 100')
  lastValue?: string | number;
  /**
   * For a live value: saves the value from the reply on each poll. It gets null when there is no reply,
   * and then forgets the old value, so that a value such as "running" does not stay old.
   */
  saveLive?: (reply: string | null, data: HaasMachineData) => void;
}

export function buildCommandString(cmd: HaasCommand): string {
  if (cmd.macroLocation !== undefined) {
    return `?${cmd.queryStart} ${cmd.macroLocation}\n`;
  }
  return `?${cmd.queryStart}\n`;
}

/**
 * The value in a query reply, or null.
 * Expected format: ">MACRO, 123.456\r\n" or ">MODE, MEM\r\n"
 * An unknown command gets ">?, ?Q105\r\n", which is not a value.
 */
export function parseQueryResponse(response: string, isMacro: boolean): string | null {
  const cleaned = response.replace(/>/g, '').replace(/\r\n/g, '').trim();

  if (!cleaned.includes(',')) return null;
  if (cleaned.startsWith('?')) return null;
  if (isMacro && !cleaned.includes('MACRO')) return null;

  return cleaned.split(',')[1].trim();
}

/** The execution word of Q500 ALARM ON */
const ALARM_EXECUTION = 'STOPPED';

/** The Q500 status words, in MTConnect execution words */
const RUN_STATUS_EXECUTION: Record<string, string> = {
  'BUSY': 'ACTIVE',
  'IDLE': 'READY',
  'FEED HOLD': 'FEED_HOLD',
  'ALARM ON': ALARM_EXECUTION,
};

/**
 * Read the run status from a Q500 reply, in MTConnect execution words, or null.
 * While a program runs the control answers only "STATUS, BUSY".
 * Else it answers "PROGRAM, O01234, IDLE, PARTS, 380" (or FEED HOLD, or ALARM ON).
 * Older controls put STX and ETB bytes around the reply; NGC starts it with ">".
 */
export function parseRunStatus(response: string): string | null {
  // The reply can hold control characters. This regex removes them on purpose.
  // eslint-disable-next-line no-control-regex
  const fields = response.replace(/[\x00-\x1f>]/g, '').split(',').map(field => field.trim());
  const statusWord = fields[0] === 'STATUS' ? fields[1] : fields[0] === 'PROGRAM' ? fields[2] : undefined;
  return (statusWord && RUN_STATUS_EXECUTION[statusWord]) || null;
}

/** The macro that holds the spindle load in percent, with a Haas vector drive (NGC and older controls) */
const SPINDLE_LOAD_MACRO = 1098;

/** The number in a macro reply such as "MACRO, 37.000000", or undefined */
function macroNumber(reply: string | null): number | undefined {
  const value = reply === null ? null : parseQueryResponse(reply, true);
  const number = value === null ? NaN : parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

/** A data stream value as the type of its field */
function dataStreamValue(field: keyof HaasMachineData, raw: string): string | number {
  switch (field) {
    case 'toolNumber': return parseInt(raw, 10) || 0;
    case 'spindleSpeed': return Math.round((parseInt(raw, 10) || 0) / SPINDLE_RPM_SCALE);
    default: return raw;
  }
}

interface SocketOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** The start of the timeout error, for example "Data stream" */
  name: string;
  /** Runs when the socket times out, fails or closes */
  onDown: () => void;
}

/** Connect the socket. Rejects on a timeout or an error before the socket connects. */
export function openSocket(socket: net.Socket, options: SocketOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.setTimeout(options.timeoutMs);
    tuneMachineSocket(socket);

    socket.on('timeout', () => {
      options.onDown();
      reject(new Error(`${options.name} connection timeout`));
    });

    socket.on('error', (err: Error) => {
      options.onDown();
      reject(err);
    });

    // A destroyed socket gives only 'close'. Without a reject here, a disconnect during the connect waits forever.
    socket.on('close', () => {
      options.onDown();
      reject(new Error(`${options.name} connection closed before it opened`));
    });

    socket.connect(options.port, options.host, resolve);
  });
}

/**
 * Connector for Haas CNC machines
 * Uses two connections:
 * - Data stream (port 9998): Real-time push data
 * - Query port (port 5051): Command/response queries
 */
export class HaasConnector extends BaseMachineConnector {
  readonly type: MachineType = 'haas';

  public dataPort: number;
  public queryPort: number;
  public macros: MacroConfig[];

  private dataSocket: net.Socket | null = null;
  private querySocket: net.Socket | null = null;
  /** The chunks of the data stream line that waits for its delimiter, and their size */
  private dataRest: Buffer[] = [];
  private dataRestLength = 0;
  /** The last bytes of the rest, so a delimiter that is split over two chunks is found */
  private dataRestTail: Buffer = Buffer.alloc(0);
  private data: HaasMachineData = {};
  private prevData: HaasMachineData = {};
  private commands: HaasCommand[] = [];
  private dataStreamConnected = false;
  private queryConnected = false;
  /** Why Chatter closed the data stream between two polls. The next poll shows it once. */
  private dataStreamError: string | null = null;

  constructor(config: HaasMachineConfig) {
    super(config);

    this.id = config.id || `haas_${Date.now()}`;
    this.name = config.name || 'Haas CNC';
    this.dataPort = config.dataPort || DEFAULT_DATA_PORT;
    this.queryPort = config.queryPort || DEFAULT_QUERY_PORT;
    this.macros = config.macros || [];
    this.commands = this.buildCommands();
  }

  /** The standard queries, then one query for each configured macro */
  private buildCommands(): HaasCommand[] {
    const macroCommands = this.macros.map(macro => ({
      queryStart: 'Q600',
      macroLocation: macro.location,
      label: this.formatMacroLabel(macro.location, macro.name),
    }));

    return [
      { queryStart: 'Q104', label: 'mode' },
      // Run status: Q500 tells if a program runs (see parseRunStatus).
      {
        queryStart: 'Q500',
        label: 'execution',
        saveLive: (reply, data) => { data.execution = (reply && parseRunStatus(reply)) ?? undefined; },
      },
      {
        queryStart: 'Q600',
        macroLocation: SPINDLE_LOAD_MACRO,
        label: 'spindleLoad',
        saveLive: (reply, data) => { data.spindleLoad = macroNumber(reply); },
      },
      // Part count: Q402 replies "M30 #1, 380" (M30 counter #1).
      // Not from Q500, because Q500 gives no part count while a program runs.
      // The NGC manual has no Q command for a part goal; shops that keep one in a macro can add it as a macro.
      { queryStart: 'Q402', label: 'partCount' },
      ...macroCommands,
    ];
  }

  updateMacros(macros: MacroConfig[]): void {
    this.macros = macros;
    this.commands = this.buildCommands();
  }

  /** Connect both ports. The machine counts as connected when one of them connects. */
  async connect(): Promise<void> {
    this.clearErrors();

    try {
      await this.connectDataStream();
    } catch (err) {
      this.addError(`Data stream connection failed: ${errorMessage(err)}`);
    }

    try {
      await this.connectQueryPort();
    } catch (err) {
      this.addError(`Query port connection failed: ${errorMessage(err)}`);
    }

    this.connected = this.dataStreamConnected || this.queryConnected;
  }

  private async connectDataStream(): Promise<void> {
    this.dataSocket?.destroy();

    const socket = new net.Socket();
    this.dataSocket = socket;
    socket.on('data', (chunk: Buffer) => this.handleDataStreamData(socket, chunk));

    await openSocket(socket, {
      host: this.host,
      port: this.dataPort,
      timeoutMs: this.timeout,
      name: 'Data stream',
      onDown: () => { this.dataStreamConnected = false; },
    });
    socket.write(DATA_STREAM_INIT, 'ascii');
    this.dataStreamConnected = true;
  }

  private async connectQueryPort(): Promise<void> {
    this.querySocket?.destroy();

    const socket = new net.Socket();
    this.querySocket = socket;
    socket.setMaxListeners(MAX_QUERY_SOCKET_LISTENERS);

    await openSocket(socket, {
      host: this.host,
      port: this.queryPort,
      timeoutMs: this.timeout,
      name: 'Query port',
      onDown: () => { this.queryConnected = false; },
    });
    this.queryConnected = true;
  }

  /**
   * The data stream can split a line over several chunks, so keep the rest until its delimiter comes.
   * A rest longer than MAX_HAAS_LINE_BYTES closes the data stream. The next poll connects it again.
   */
  private handleDataStreamData(socket: net.Socket, chunk: Buffer): void {
    // Search only the new chunk and the last bytes before it. Join the chunks only when a line is complete.
    // So a long line in many small chunks does not take more and more time.
    const searched = Buffer.concat([this.dataRestTail, chunk]);
    this.dataRestTail = Buffer.from(searched.subarray(-(DATA_DELIMITER.length - 1)));
    this.dataRest.push(chunk);
    this.dataRestLength += chunk.length;
    if (searched.includes(DATA_DELIMITER)) this.parseCompleteLines();

    if (this.dataRestLength > MAX_HAAS_LINE_BYTES) {
      const error = warnReplyTooLarge(log, this.id, new ReplyTooLargeError(MAX_HAAS_LINE_BYTES));
      this.dataStreamError = `Data stream: ${error.message}`;
      this.clearDataRest();
      socket.destroy();
    }
  }

  /** Parse each complete line of the rest, and keep only the part after the last delimiter */
  private parseCompleteLines(): void {
    const data = Buffer.concat(this.dataRest);
    let start = 0;
    let end: number;
    while ((end = data.indexOf(DATA_DELIMITER, start)) !== -1) {
      this.parseDataStreamLine(data.toString('ascii', start, end));
      start = end + DATA_DELIMITER.length;
    }
    // A copy, so the rest does not keep the joined lines in memory
    const rest = Buffer.from(data.subarray(start));
    this.dataRest = rest.length > 0 ? [rest] : [];
    this.dataRestLength = rest.length;
  }

  private clearDataRest(): void {
    this.dataRest = [];
    this.dataRestLength = 0;
    this.dataRestTail = Buffer.alloc(0);
  }

  /**
   * Parse a line from the data stream
   * Format: "key|value|key|value|..."
   */
  private parseDataStreamLine(line: string): void {
    if (!line) return;

    const parts = line.split('|');
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const field = DATA_STREAM_FIELDS[key];
      if (!field) continue;

      const value = dataStreamValue(field, parts[i + 1].split('\n')[0]);
      if (key === 'alarm0') {
        this.data.alarm = value !== '' && value !== '0';
        this.data.alarmCode = value as string;
      } else {
        this.data[field] = value;
      }
    }
  }

  disconnect(): void {
    if (this.dataSocket) {
      try {
        this.dataSocket.write(DATA_STREAM_DISCONNECT, 'ascii');
      } catch {
        // The socket may be closed already; it is destroyed next either way
      }
      this.dataSocket.destroy();
      this.dataSocket = null;
    }

    if (this.querySocket) {
      this.querySocket.destroy();
      this.querySocket = null;
    }

    this.dataStreamConnected = false;
    this.queryConnected = false;
    this.connected = false;
    this.clearDataRest();
  }

  private updateAlarmText(): void {
    if (!this.data.alarm || !this.data.alarmCode) {
      this.data.alarmText = undefined;
      return;
    }

    const code = String(this.data.alarmCode);
    const text = haasAlarmText(code);
    if (text) {
      this.data.alarmText = text;
      log.debug('Haas alarm', { machine: this.id, code, text });
    } else {
      this.data.alarmText = `ALARM ${code}`;
      log.debug('Haas alarm code with no known text', { machine: this.id, code });
    }
  }

  /**
   * Send a query command and get the raw reply, or null when no reply comes in time.
   * A reply longer than MAX_HAAS_QUERY_REPLY_BYTES closes the query port and rejects.
   */
  private async sendQuery(cmd: HaasCommand): Promise<string | null> {
    const socket = this.querySocket;
    if (!socket || !this.queryConnected) {
      return null;
    }

    return new Promise((resolve, reject) => {
      let reply = '';
      const timeout = setTimeout(() => finish(null), QUERY_REPLY_TIMEOUT_MS);

      const onData = (chunk: Buffer) => {
        const searchFrom = reply.length;
        reply += chunk.toString('ascii');
        if (reply.includes('\n', searchFrom)) {
          finish(reply);
        } else if (reply.length > MAX_HAAS_QUERY_REPLY_BYTES) {
          stop();
          socket.destroy();
          reject(warnReplyTooLarge(log, this.id, new ReplyTooLargeError(MAX_HAAS_QUERY_REPLY_BYTES)));
        }
      };
      const onError = () => finish(null);

      const stop = () => {
        clearTimeout(timeout);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      };
      const finish = (result: string | null) => {
        stop();
        resolve(result);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(buildCommandString(cmd), 'ascii');
    });
  }

  private async pollCommands(): Promise<void> {
    for (const cmd of this.commands) {
      if (!this.queryConnected) break;

      const reply = await this.sendQuery(cmd);
      if (cmd.saveLive) {
        cmd.saveLive(reply, this.data);
        continue;
      }
      const value = reply === null ? null : parseQueryResponse(reply, cmd.macroLocation !== undefined);
      if (value !== null && value !== cmd.lastValue) {
        cmd.lastValue = value;
        this.saveQueryValue(cmd.label, value);
      }
    }
  }

  /** The mode is text, the part count a whole number, and a macro a number when it can be one */
  private saveQueryValue(label: string, value: string): void {
    if (label === 'mode') {
      this.data.mode = value;
    } else if (label === 'partCount') {
      const count = parseInt(value, 10);
      this.data.partCount = isNaN(count) ? 0 : count;
    } else {
      const number = parseFloat(value);
      this.data[label] = isNaN(number) ? value : number;
    }
  }

  async poll(): Promise<HaasMachineStatus> {
    this.clearErrors();
    const reconnected = await this.reconnectClosedPorts();
    // After the reconnect, because connect() clears the errors
    if (this.dataStreamError) {
      this.addError(this.dataStreamError);
      this.dataStreamError = null;
    }
    if (!reconnected) {
      return this.getStatus();
    }

    this.prevData = { ...this.data };

    if (this.queryConnected) {
      try {
        await this.pollCommands();
      } catch (err) {
        this.addError(`Query error: ${errorMessage(err)}`);
      }
    }

    this.updateAlarmText();
    this.updatePollTime();
    this.emitDataChanges(this.prevData, this.data);

    return this.getStatus();
  }

  /** Connect the ports that are not connected. Gives false when a full reconnect fails. */
  private async reconnectClosedPorts(): Promise<boolean> {
    if (!this.dataStreamConnected && !this.queryConnected) {
      try {
        await this.connect();
      } catch (err) {
        this.addError(`Connection failed: ${errorMessage(err)}`);
        return false;
      }
    }

    // Each port is optional while the other one works, so a failed retry is not an error
    if (!this.dataStreamConnected) {
      await this.connectDataStream().catch(() => {});
    }
    if (!this.queryConnected) {
      await this.connectQueryPort().catch(() => {});
    }

    this.connected = this.dataStreamConnected || this.queryConnected;
    return true;
  }

  getStatus(): HaasMachineStatus {
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      dataPort: this.dataPort,
      queryPort: this.queryPort,
      ftpPort: this.ftpPort,
      ftpUser: this.ftpUser,
      hasFtpPassword: this.hasFtpPassword,
      type: 'haas',
      connected: this.connected,
      lastPollTime: this.lastPollTime,
      errors: this.errors,
      data: { ...this.data },
      macros: this.macros
    };
  }

  checkConnection(): boolean {
    return this.dataStreamConnected || this.queryConnected;
  }

  getDataSnapshot(): MachineDataSnapshot {
    return this.buildSnapshot({
      mode: this.data.mode,
      program: this.data.program,
      spindleSpeed: this.data.spindleSpeed,
      toolNumber: this.data.toolNumber,
      partCount: this.data.partCount,
      partGoal: this.data.partGoal,
      // Q500 ALARM ON is an alarm too, also when the data stream gives no alarm value
      alarm: this.data.execution === ALARM_EXECUTION ? true : this.data.alarm,
      alarmCode: this.data.alarmCode,
      execution: this.data.execution,
      spindleLoad: this.data.spindleLoad,
    }, this.macroValues(this.macros, this.data));
  }

  /** Change the connection settings that are set in `config`, and disconnect so the next poll uses them */
  updateConfig(config: {
    host?: string;
    dataPort?: number;
    queryPort?: number;
    ftpPort?: number;
    ftpUser?: string;
    ftpPassword?: string;
  }): void {
    if (config.host) this.host = config.host;
    if (config.dataPort) this.dataPort = config.dataPort;
    if (config.queryPort) this.queryPort = config.queryPort;

    this.updateFTPConfig(config);
    this.disconnect();
  }
}
