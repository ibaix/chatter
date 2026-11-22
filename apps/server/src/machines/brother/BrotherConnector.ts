import net from 'net';
import { BaseMachineConnector } from '../BaseMachineConnector.js';
import { PollTimingRecorder } from '../pollTimings.js';
import { tuneMachineSocket } from '../machineSocket.js';
import { createLogger } from '../../logging/logger.js';
import { TOOL_SYNC_TIMEOUT_MS, ToolSyncTracker, isIdle, type ToolSyncRefusal } from './toolSync.js';
import type {
  BrotherMachineConfig,
  BrotherMachineStatus,
  BrotherMachineData,
  ToolTable,
  DataItem,
  DataItemType,
  DataItemTransform,
  ParsedResponse,
  MachineType,
  MacroConfig,
  MachineDataSnapshot,
  ToolSyncState,
} from '../../types/index.js';

const log = createLogger('brother');

const DEFAULT_DATA_PORT = 10000;

/**
 * Chatter closes the data connection on purpose and opens it again every 60 seconds, at the start of a poll.
 * This renews the session on the control, and limits how long a bad state of that session can last.
 * A Brother serves one client at a time, so the close is an orderly close (FIN), and the control frees its
 * client slot before the new connect. It does not help with a half-open session on the control after the Pi
 * lost power: TCP keepalive and the timeout of the control cover that.
 */
export const BROTHER_RECONNECT_MS = 60_000;

/** The time that an orderly close can take before Chatter destroys the socket */
const ORDERLY_CLOSE_MS = 2000;
const DEFAULT_UNIT = 'in';

const PANEL_MODES = ['MANUAL', 'MDI', 'MEMORY', 'EDIT'];

/** The two-digit start of an ALARM E01 value, and the letters that Brother shows for it */
const ALARM_PREFIXES: Record<string, string> = {
  '01': 'EX', '02': 'EC', '03': 'SV', '04': 'NC', '05': 'IO', '06': 'SP',
  '07': 'SM', '08': 'SL', '09': 'CM', '10': 'ES', '11': 'FC', '90': 'OM',
};
/** CM is a communication message and OM means no alarm, so neither is a machine alarm */
const NOT_ALARMS = ['CM', 'OM'];

/** MEM A01 "operation status", in MTConnect execution words */
const OPERATION_STATUS_EXECUTION: Record<string, string> = {
  '0': 'READY', '1': 'ACTIVE', '2': 'FEED_HOLD', '3': 'INTERRUPTED',
};

// Transformers for special value parsing
const TRANSFORMS: Record<string, DataItemTransform> = {
  mode: (val) => {
    const index = Math.floor(parseFloat(String(val)));
    return PANEL_MODES[index] ?? index;
  },

  alarm: (val) => {
    const prefix = ALARM_PREFIXES[String(val).trim().substring(0, 2)];
    return prefix !== undefined && !NOT_ALARMS.includes(prefix);
  },

  // From open-source schemas that cite the Brother manual (C00 5.6.4.8, D00 3.6.5.8). Not tested on a real machine yet.
  execution: (val) => OPERATION_STATUS_EXECUTION[String(val).trim()] ?? '',

  alarmCode: (val) => {
    const trimmed = String(val).trim();
    const prefix = ALARM_PREFIXES[trimmed.substring(0, 2)];
    if (prefix === 'OM') return '';
    return prefix ? prefix + trimmed.substring(2) : trimmed;
  },
};

// Data item definitions: [label, command, key, index, type, transform?]
// Labels use normalized camelCase field names matching MachineData interface
const DATA_ITEMS: DataItem[] = [
  ['mode',         'PANEL',  'K01', 0, 'string', TRANSFORMS.mode],
  ['program',      'MEM',    'A01', 1, 'string'],
  ['execution',    'MEM',    'A01', 2, 'string', TRANSFORMS.execution],
  ['partCount',    'WKCNTR', 'A01', 1, 'int'],
  ['partGoal',     'WKCNTR', 'A01', 2, 'int'],
  ['toolNumber',   'PDSP',   'X01', 3, 'int'],
  ['spindleSpeed', 'PDSP',   'X01', 1, 'int'],
];

/** The command for the alarm list. Its E01 line has one slot for each alarm or message. */
const ALARM_COMMAND = 'ALARM';

/**
 * The alarm and its code, from all the slots of the E01 alarm list. A slot can hold a communication message (CM)
 * or "no alarm" (OM). A Speedio puts a CM entry in the list when it gets a command that it does not know, so a
 * real alarm can be in a later slot. The alarm code is the code of the first real alarm.
 */
function alarmOfList(slots: string[]): { alarm: boolean; alarmCode: string } {
  const firstAlarm = slots.map(slot => withoutQuotes(slot)).find(slot => slot !== '' && TRANSFORMS.alarm(slot) === true);
  return firstAlarm === undefined
    ? { alarm: false, alarmCode: '' }
    : { alarm: true, alarmCode: String(TRANSFORMS.alarmCode(firstAlarm)) };
}

/** The value of each type when the machine sends nothing */
const EMPTY_VALUES: Record<DataItemType, string | number | boolean> = {
  int: 0,
  float: 0,
  bool: false,
  string: '',
};

/** Brother puts text values in single quotes */
function withoutQuotes(text: string): string {
  return text.trim().replace(/^'|'$/g, '').trim();
}

/** Convert a raw value to the given type, after the transform when there is one */
function parseValue(
  raw: string | undefined,
  type: DataItemType,
  transform?: DataItemTransform
): string | number | boolean {
  let val: string | number | boolean = typeof raw === 'string' ? withoutQuotes(raw) : (raw ?? '');
  if (transform) val = transform(val);

  if (val === '' || val === null || val === undefined) {
    return EMPTY_VALUES[type] ?? '';
  }

  switch (type) {
    case 'int': return Math.floor(parseFloat(String(val)));
    case 'float': return parseFloat(String(val));
    case 'bool': return Boolean(val);
    default: return String(val);
  }
}

/**
 * The error when the machine accepts the TCP connection but does not answer a command.
 * A Brother control serves one client at a time. It accepts a second connection, but it does not answer on it.
 */
export const NO_REPLY_ERROR =
  'The machine accepts the connection, but it does not answer. Possibly another program is connected to it. ' +
  'A Brother control serves only one program at a time. Stop the other program. If you cannot find it, turn the control off and on again.';

/** A command got no reply in time. The connection is not usable after this. */
class NoReplyError extends Error {
  constructor() {
    super(NO_REPLY_ERROR);
  }
}

/** A command or a connect waits no more when its socket closes, for example when the poll ran out of time */
const CLOSED_BEFORE_REPLY_ERROR = 'The connection closed before the machine answered';
const CLOSED_BEFORE_OPEN_ERROR = 'The connection closed before it opened';

/** A Brother request: "%CLOD    <command>  ", then a checksum, between % signs */
export function brotherCommand(command: string): string {
  const cmdBody = 'CLOD'.padEnd(8) + command.padEnd(8) + '  \r\n';
  const checksum = [...cmdBody].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 16;
  return `%${cmdBody}\r\n${String(checksum).padStart(2, '0')}%\r\n`;
}

type ControlType = 'C00' | 'D00';
type AtcCommand = 'ATCTL' | 'ATCTLD';

/** Each control type has its own command for the tool in each ATC pot. Chatter tries them in this order. */
const ATC_COMMANDS: Array<{ command: AtcCommand; controlType: ControlType }> = [
  { command: 'ATCTL', controlType: 'C00' },
  { command: 'ATCTLD', controlType: 'D00' },
];

/** The ATC reply has the keys M02 to M51, for pots 1 to 50 */
const FIRST_POT_KEY = 2;
const LAST_POT_KEY = 51;
const MAX_TOOL_NUMBER = 99;

/** The position of each value in a row of the tool data reply */
const TOOL_DATA_COLUMN = { length: 0, lengthWear: 1, diameter: 2, diameterWear: 3, name: 8 } as const;

/** The mode, the program and run state, and the alarm. Each poll sends these first, and never skips them. */
const CORE_COMMANDS = ['PANEL', 'MEM', ALARM_COMMAND];

/**
 * A poll sends an optional command only when it fits in the poll limit less this margin: 20 %, which is 2 s
 * of the 10 s limit. The margin is for a reply that is slower than its estimate: it is more than one
 * reply of a slow but working Brother (about 1.5 s), so the poll ends in time.
 */
const BUDGET_MARGIN_SHARE = 0.2;

/** What a Sync request gives */
export type ToolSyncResult =
  | { outcome: 'synced' | 'failed'; toolSync: ToolSyncState }
  | ToolSyncRefusal
  | { outcome: 'not-connected' };

/** The key of the reply status in a parsed reply. No data key of a Brother starts with @. */
export const REPLY_STATUS_KEY = '@status';
/** The header line of a reply: "RLOD", the command, and a status of 2 digits */
const REPLY_HEADER = /^RLOD\s+\S+?\s*(\d{2})$/;

/**
 * The control knows the ATC command: the reply status is 00, also with no pots (an empty magazine).
 * A reply with no status line counts as known only when it has pots (M## keys).
 */
function isKnownAtcReply(response: ParsedResponse): boolean {
  const status = response[REPLY_STATUS_KEY]?.[0];
  if (status !== undefined) return status === '00';
  return Object.keys(response).some(key => /^M\d{2}$/.test(key));
}

/**
 * Connector for Brother CNC machines via telnet
 */
export class BrotherConnector extends BaseMachineConnector {
  readonly type: MachineType = 'brother';

  public dataPort: number;
  public defaultUnit: string;
  public macros: MacroConfig[];

  private socket: net.Socket | null = null;
  /** When connect() opened the connection */
  private connectedAt: number | null = null;
  private data: BrotherMachineData = {};
  private prevData: BrotherMachineData = {};
  private toolTable: ToolTable = {};
  /** The tool in each pot, from the last ATC reply */
  private potTools: Record<number, number> = {};
  /** The offsets and the name of each tool, from the last tool data reply */
  private toolOffsets = new Map<number, Omit<ToolTable[number], 'toolNum'>>();
  private hasPocketInfo = false;
  private controlType: ControlType | null = null;
  private atcCommand: AtcCommand | null = null;
  /**
   * The ATC commands that the control does not know (a reply status other than 00). This stays for the life of the
   * connector, also after a reconnect, so Chatter never sends a command that the control does not know again.
   */
  private unknownAtcCommands = new Set<AtcCommand>();
  private toolDataCommand: string;
  private macroCommand: string;
  private dataItems: DataItem[];
  private readonly timings: PollTimingRecorder;
  private readonly toolSync = new ToolSyncTracker();
  /** The state poll that runs now, so a tool read waits for it. One operation at a time uses the connection. */
  private runningPoll: Promise<void> | null = null;
  /** The tool read that runs now. A state poll does not use the connection while it runs. */
  private runningToolSync: Promise<ToolSyncResult> | null = null;
  /** The optional commands that the last poll skipped. The next poll sends them first. */
  private skippedLastPoll: string[] = [];

  constructor(config: BrotherMachineConfig) {
    super(config);

    this.id = config.id || `brother_${Date.now()}`;
    this.name = config.name || 'Brother CNC';
    this.dataPort = config.dataPort || DEFAULT_DATA_PORT;
    this.defaultUnit = (config.defaultUnit || DEFAULT_UNIT).toLowerCase();
    this.macros = config.macros || [];

    // The tool data and macro commands end with I for inch values or M for metric values
    const unitLetter = this.defaultUnit === 'in' ? 'I' : 'M';
    this.toolDataCommand = `TOLN${unitLetter}1`;
    this.macroCommand = `MCRN${unitLetter}1`;

    this.dataItems = this.buildDataItems();
    this.timings = new PollTimingRecorder(this.id);
  }

  /** The standard data items, then one item for each configured macro */
  private buildDataItems(): DataItem[] {
    const macroItems = this.macros.map((macro): DataItem =>
      [this.formatMacroLabel(macro.location, macro.name), this.macroCommand, 'C' + macro.location, 0, 'float']);
    return [...DATA_ITEMS, ...macroItems];
  }

  updateMacros(macros: MacroConfig[]): void {
    this.macros = macros;
    this.dataItems = this.buildDataItems();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) this.socket.destroy();

      const socket = new net.Socket();
      this.socket = socket;
      // The same time limit is for the connect and, in sendCommand, for each reply
      socket.setTimeout(this.timeout);
      tuneMachineSocket(socket);

      // Only for the connect. After it, a timeout means that a command got no reply (see sendCommand).
      const onConnectTimeout = () => {
        this.connected = false;
        this.addError('Connection timeout');
        socket.destroy();
        reject(new Error('Connection timeout'));
      };
      socket.on('timeout', onConnectTimeout);

      socket.on('error', (err: Error) => {
        this.connected = false;
        this.addError(`Socket error: ${err.message}`);
        reject(err);
      });

      // A destroyed socket gives only 'close'. Without this, a disconnect during the connect leaves it waiting forever.
      socket.on('close', () => {
        if (this.socket === socket) this.connected = false;
        reject(new Error(CLOSED_BEFORE_OPEN_ERROR));
      });

      socket.connect(this.dataPort, this.host, () => {
        socket.removeListener('timeout', onConnectTimeout);
        this.connected = true;
        this.connectedAt = Date.now();
        this.clearErrors();
        resolve();
      });
    });
  }

  /**
   * Close the connection with a FIN, and wait until the control closes its side too, for at most ORDERLY_CLOSE_MS.
   * Then the control has freed its one client slot for the next connect.
   */
  private async closeInOrder(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (!socket) return;
    // The listeners of connect() would report an error of the closing socket as an error of the machine
    socket.removeAllListeners('error');
    socket.on('error', () => socket.destroy());
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => socket.destroy(), ORDERLY_CLOSE_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  /**
   * Send a command and wait for the reply between % signs.
   * With no reply in time, it disconnects: a late reply would come as the reply of the next command.
   * It also ends when the socket closes, because a destroyed socket gives no 'data', 'error' or 'timeout' after it.
   */
  async sendCommand(command: string): Promise<ParsedResponse> {
    const socket = this.socket;
    if (!socket || !this.connected || socket.destroyed || !socket.writable) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      let reply = '';

      const onData = (chunk: Buffer) => {
        reply += chunk.toString('ascii');
        const match = reply.match(/%([^%]*)%/);
        if (match) {
          cleanup();
          resolve(this.parseResponse(match[1]));
        }
      };

      const onError = (err: Error) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error(CLOSED_BEFORE_REPLY_ERROR)); };
      const onTimeout = () => {
        cleanup();
        this.disconnect();
        reject(new NoReplyError());
      };

      const cleanup = () => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
        socket.removeListener('close', onClose);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('timeout', onTimeout);
      socket.on('close', onClose);
      socket.write(brotherCommand(command), 'ascii');
    });
  }

  /**
   * Each reply line is "KEY,value,value,..."; lines with no comma are headers. The status of the header line
   * "RLOD    <command>  00" is under REPLY_STATUS_KEY: 00 is good, another value (for example 08) means that the
   * control does not know the command.
   */
  parseResponse(response: string): ParsedResponse {
    const result: ParsedResponse = {};
    for (const line of response.split('\r\n')) {
      const parts = line.split(',');
      if (parts.length > 1) {
        result[parts[0]] = parts.slice(1).map(s => s.trim());
      }
      const status = REPLY_HEADER.exec(line)?.[1];
      if (status !== undefined) result[REPLY_STATUS_KEY] = [status];
    }
    return result;
  }

  /** True when Chatter found the ATC command, or found that the control knows neither command */
  private get atcDetectionDone(): boolean {
    return this.atcCommand !== null || ATC_COMMANDS.every(({ command }) => this.unknownAtcCommands.has(command));
  }

  /**
   * Find which ATC command this control knows, and give its reply, which is the first tool table. With neither,
   * the tool table has no pots, and the reply is null. Only the reply status decides. An error from a send (no
   * reply, or a closed connection) tells nothing about the control: the tool read fails, and the next one asks
   * again. Chatter does not ask a command again when the control did not know it: an unknown command adds a CM
   * entry to its alarm list.
   */
  private async detectControlType(): Promise<ParsedResponse | null> {
    for (const { command, controlType } of ATC_COMMANDS) {
      if (this.unknownAtcCommands.has(command)) continue;
      const response = await this.send(command);
      if (isKnownAtcReply(response)) {
        this.atcCommand = command;
        this.controlType = controlType;
        return response;
      }
      this.unknownAtcCommands.add(command);
    }
    return null;
  }

  /**
   * Forget what Chatter found about the control: the ATC command, the control type and the tool table.
   * Use it when the address changes, because a different control can be at the new address.
   */
  forgetControl(): void {
    this.atcCommand = null;
    this.controlType = null;
    this.unknownAtcCommands.clear();
    this.potTools = {};
    this.toolOffsets = new Map();
    this.toolTable = {};
    this.hasPocketInfo = false;
  }

  /** The tool in each pot, from the ATC reply */
  private updatePotTools(atcResponse: ParsedResponse): void {
    this.potTools = {};
    for (let potKey = FIRST_POT_KEY; potKey <= LAST_POT_KEY; potKey++) {
      const rawValue = atcResponse[`M${String(potKey).padStart(2, '0')}`]?.[0];
      const toolNum = parseInt(rawValue, 10);
      if (toolNum >= 1 && toolNum <= MAX_TOOL_NUMBER) {
        this.potTools[potKey - 1] = toolNum;
      }
    }
  }

  /** The offsets and names from the tool data reply */
  private updateToolOffsets(toolDataResponse: ParsedResponse): void {
    // Some controls send 3-digit keys (T001), others 2-digit keys (T01)
    const keyDigits = toolDataResponse['T001'] !== undefined ? 3 : 2;

    this.toolOffsets = new Map();
    for (let toolNum = 1; toolNum <= MAX_TOOL_NUMBER; toolNum++) {
      const values = toolDataResponse[`T${String(toolNum).padStart(keyDigits, '0')}`];
      if (!values) continue;
      this.toolOffsets.set(toolNum, {
        length: parseFloat(values[TOOL_DATA_COLUMN.length]) || 0,
        lengthWear: parseFloat(values[TOOL_DATA_COLUMN.lengthWear]) || 0,
        diameter: parseFloat(values[TOOL_DATA_COLUMN.diameter]) || 0,
        diameterWear: parseFloat(values[TOOL_DATA_COLUMN.diameterWear]) || 0,
        name: withoutQuotes(values[TOOL_DATA_COLUMN.name] || ''),
      });
    }
  }

  /**
   * The tool table: the tool in each pot, with its offsets and name. A poll can read the pots and the tool data
   * at different times, so the table is made from the last reply of each.
   */
  private updateToolTable(): void {
    this.toolTable = {};
    for (const [pot, toolNum] of Object.entries(this.potTools)) {
      this.toolTable[Number(pot)] = { toolNum, ...this.toolOffsets.get(toolNum) };
    }
    this.hasPocketInfo = Object.keys(this.toolTable).length > 0;
  }

  /**
   * Read the machine state. While a tool read runs, the poll does not use the connection: it gives the last values,
   * and is a good poll. After a good poll that finds the machine idle, it can start a tool read (see ToolSyncTracker).
   */
  async poll(): Promise<BrotherMachineStatus> {
    if (this.runningToolSync) return this.getStatus();
    this.clearErrors();
    this.timings.startPoll();
    const run = this.pollMachine();
    this.runningPoll = run;
    try {
      await run;
    } finally {
      this.runningPoll = null;
      this.timings.endPoll(this.pollTimeLimitMs);
    }
    if (this.connected && this.lastPollTime && isIdle(this.data) && this.toolSync.autoSyncDue(Date.now())) {
      // Not awaited: the tool read runs between the state polls, with its own time limit
      void this.startToolSync('auto');
    }
    return this.getStatus();
  }

  /** A user pressed Sync: read the tools now, also while a program runs */
  async requestToolSync(): Promise<ToolSyncResult> {
    const refusal = this.toolSync.manualRefusal(Date.now());
    if (refusal) return refusal;
    if (!this.connected) return { outcome: 'not-connected' };
    return this.startToolSync('manual');
  }

  /** Resolves when no tool read runs */
  async toolSyncEnded(): Promise<void> {
    await this.runningToolSync;
  }

  private startToolSync(trigger: 'auto' | 'manual'): Promise<ToolSyncResult> {
    this.toolSync.started(Date.now(), trigger);
    const run = this.syncTools(trigger).finally(() => { this.runningToolSync = null; });
    this.runningToolSync = run;
    return run;
  }

  /** Read the tools after the state poll that runs now, in TOOL_SYNC_TIMEOUT_MS at most */
  private async syncTools(trigger: 'auto' | 'manual'): Promise<ToolSyncResult> {
    await this.runningPoll?.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Ends the command that waits, and the next poll connects again
        this.disconnect();
        reject(new Error(`The tool read did not end in ${TOOL_SYNC_TIMEOUT_MS / 1000} seconds`));
      }, TOOL_SYNC_TIMEOUT_MS);
    });
    let error: string | null = null;
    try {
      await Promise.race([this.readTools(), timeout]);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    this.toolSync.ended(Date.now(), error);
    log.debug('Tool read', { machine: this.id, trigger, error: error ?? undefined });
    return { outcome: error === null ? 'synced' : 'failed', toolSync: this.toolSync.state() };
  }

  /** Read the tool table and the tool data. The first time, find the control type: its reply is also the tool table. */
  private async readTools(): Promise<void> {
    const atcResponse = this.atcCommand ? await this.send(this.atcCommand) : this.atcDetectionDone ? null : await this.detectControlType();
    if (atcResponse && this.atcCommand) this.updatePotTools(atcResponse);
    const toolDataResponse = await this.send(this.toolDataCommand);
    this.updateToolOffsets(toolDataResponse);
    this.updateToolTable();
  }

  /** Connect when needed, read the machine, and keep the values */
  private async pollMachine(): Promise<void> {
    if (!(await this.connectForPoll())) return;

    this.prevData = { ...this.data };

    const responses = await this.readMachine();
    if (!responses) return;

    this.saveDataItems(responses);

    this.updatePollTime();
    this.emitDataChanges(this.prevData, this.data);
  }

  /**
   * Connect when not connected, and make the planned reconnect when it is time. False when the connect fails.
   * It runs at the start of a poll, so no command waits for a reply during the planned reconnect.
   */
  private async connectForPoll(): Promise<boolean> {
    const planned = this.connected && this.connectedAt !== null && Date.now() - this.connectedAt >= BROTHER_RECONNECT_MS;
    if (planned) await this.closeInOrder();
    if (this.socket && this.connected) return true;

    if (!(await this.ensureConnected())) return false;
    if (planned) {
      this.timings.recordPlannedReconnect();
      log.debug('Planned reconnect', { machine: this.id });
    }
    return true;
  }

  /** Send a command, and record how long the machine took to answer */
  private send(command: string): Promise<ParsedResponse> {
    return this.timings.time(command, () => this.sendCommand(command));
  }

  /** Send the poll commands, and get the replies by command. Gives null when a command fails. */
  private async readMachine(): Promise<Record<string, ParsedResponse> | null> {
    try {
      const responses: Record<string, ParsedResponse> = {};
      for (const command of CORE_COMMANDS) {
        responses[command] = await this.send(command);
      }
      await this.sendOptionalCommands(responses);
      return responses;
    } catch (err) {
      if (err instanceof NoReplyError) {
        // The message tells the cause and the fix, so it needs no "Poll failed" in front. sendCommand disconnected.
        this.addError(err.message);
      } else {
        this.handlePollError(err);
      }
      return null;
    }
  }

  /**
   * Send the other commands of the machine state.
   * A machine that answers slowly can run out of poll time. Then the poll skips the commands that do not fit,
   * keeps their last values, and the next poll sends them first. The poll is still a good poll.
   */
  private async sendOptionalCommands(responses: Record<string, ParsedResponse>): Promise<void> {
    const budgetMs = this.pollTimeLimitMs * (1 - BUDGET_MARGIN_SHARE);
    const skipped: string[] = [];
    for (const command of this.optionalCommands()) {
      if (skipped.length > 0 || !this.fitsInTime(command, budgetMs)) {
        skipped.push(command);
        this.timings.skip(command);
        continue;
      }
      responses[command] = await this.send(command);
    }
    this.skippedLastPoll = skipped;
  }

  /** The optional commands of this poll, the ones that the last poll skipped first */
  private optionalCommands(): string[] {
    const commands = [...new Set(this.dataItems.map(([, command]) => command))]
      .filter(command => !CORE_COMMANDS.includes(command));
    const first = this.skippedLastPoll.filter(command => commands.includes(command));
    return [...first, ...commands.filter(command => !first.includes(command))];
  }

  /** A machine that is slow now is slow for the next command too, so the estimate is never below the slowest reply of this poll */
  private fitsInTime(command: string, budgetMs: number): boolean {
    const estimateMs = Math.max(this.timings.estimateMs(command) ?? 0, this.timings.slowestInPollMs());
    return this.timings.elapsedMs() + estimateMs <= budgetMs;
  }

  private saveDataItems(responses: Record<string, ParsedResponse>): void {
    for (const [label, command, key, index, type, transform] of this.dataItems) {
      const raw = responses[command]?.[key]?.[index];
      if (raw !== undefined) {
        this.data[label] = parseValue(raw, type, transform);
      }
    }
    const alarmSlots = responses[ALARM_COMMAND]?.E01;
    if (alarmSlots) Object.assign(this.data, alarmOfList(alarmSlots));
  }

  getStatus(): BrotherMachineStatus {
    const pollTimings = this.timings.snapshot();
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      dataPort: this.dataPort,
      ftpPort: this.ftpPort,
      ftpUser: this.ftpUser,
      hasFtpPassword: this.hasFtpPassword,
      type: 'brother',
      connected: this.connected,
      lastPollTime: this.lastPollTime,
      errors: this.errors,
      data: {
        ...this.data,
        toolTable: this.toolTable,
        hasPocketInfo: this.hasPocketInfo,
        controlType: this.controlType,
        toolSync: this.toolSync.state(),
      },
      macros: this.macros,
      // Only after the first poll, so the status has the same fields as the status of the other connectors until then
      ...(pollTimings ? { pollTimings } : {}),
    };
  }

  checkConnection(): boolean {
    if (!this.socket || !this.connected) return false;
    try { this.socket.write('\n'); return true; }
    catch { return false; }
  }

  getDataSnapshot(): MachineDataSnapshot {
    const custom: Record<string, object> = {};
    if (Object.keys(this.toolTable).length > 0) {
      custom.toolTable = this.toolTable;
    }

    return this.buildSnapshot({
      mode: this.data.mode,
      program: this.data.program,
      spindleSpeed: this.data.spindleSpeed,
      toolNumber: this.data.toolNumber,
      partCount: this.data.partCount,
      partGoal: this.data.partGoal,
      alarm: this.data.alarm,
      alarmCode: this.data.alarmCode,
      // Empty when the control sent a status that Chatter does not know
      execution: this.data.execution || undefined,
    }, { ...custom, ...this.macroValues(this.macros, this.data) });
  }
}

// Export transformers for testing
export { TRANSFORMS, parseValue };
