import type { ConnectionEvent, MachineHealth } from '@local-chatter/shared';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import type { PollRecorder } from '../polling/poller.js';
import { createLogger, type Logger } from './logger.js';

interface MachineState {
  connected: boolean;
  /** The errors of the last poll */
  errors: string[];
  /** When the machine went offline, or null while it is online */
  offlineSince: Date | null;
}

/** The connection changes that each machine keeps for its health panel */
export const KEPT_CONNECTION_EVENTS = 10;

/** What the health panel of one machine shows: the changes, and the last error */
interface MachineHistory {
  events: ConnectionEvent[];
  lastError: { text: string; time: string } | null;
}

/** The part of the machine health that the connection log knows */
export type ConnectionHealth = Pick<MachineHealth, 'offlineSince' | 'lastError' | 'events'>;

/**
 * Writes a log line when a machine connects, goes offline, comes back, or reports a new problem.
 * A machine is polled every few seconds, so the log says only what changed, not each failed poll:
 * a machine that is off for a weekend gives one line, not thousands.
 * While a machine is still connecting (the web shows "Connecting"), a failed poll is normal, so it is not logged.
 */
export class ConnectionLog implements PollRecorder {
  private readonly states = new Map<string, MachineState>();
  private readonly histories = new Map<string, MachineHistory>();

  constructor(
    private readonly log: Logger = createLogger('machines'),
    private readonly now: () => Date = () => new Date(),
    /** True while the machine is in its first connecting time (see PollScheduler) */
    private readonly isConnecting: (machineId: string) => boolean = () => false,
  ) {}

  record(connector: BaseMachineConnector): void {
    const { id, name, type, host, connected, errors } = connector.getStatus();
    const problem = errors.join('; ');
    const machineLog = this.log.child({ machine: id, name, type, host });
    const previous = this.states.get(id);
    const now = this.now();
    this.noteError(id, problem, now);
    if (!previous && !connected && this.isConnecting(id)) return;
    for (const note of notesOf(previous, connected, errors, now)) {
      if (note.level === 'info') machineLog.info(note.message, note.details);
      else machineLog.warn(note.message, note.details);
      const text = note.tone === 'bad' && problem ? `${note.message}: ${problem}` : note.message;
      this.addEvent(id, { time: now.toISOString(), tone: note.tone, text });
    }

    const wasOffline = previous !== undefined && !previous.connected;
    this.states.set(id, {
      connected,
      errors: [...errors],
      offlineSince: connected ? null : wasOffline ? previous.offlineSince : now,
    });
  }

  removeMachine(machineId: string): void {
    this.states.delete(machineId);
    this.histories.delete(machineId);
  }

  /** Since when the machine is offline, its last error, and its last connection changes (newest first) */
  health(machineId: string): ConnectionHealth {
    const offlineSince = this.states.get(machineId)?.offlineSince ?? null;
    const history = this.histories.get(machineId);
    return {
      offlineSince: offlineSince?.toISOString() ?? null,
      lastError: history?.lastError ?? null,
      events: [...(history?.events ?? [])].reverse(),
    };
  }

  private historyOf(machineId: string): MachineHistory {
    let history = this.histories.get(machineId);
    if (!history) {
      history = { events: [], lastError: null };
      this.histories.set(machineId, history);
    }
    return history;
  }

  private addEvent(machineId: string, event: ConnectionEvent): void {
    const { events } = this.historyOf(machineId);
    events.push(event);
    if (events.length > KEPT_CONNECTION_EVENTS) events.shift();
  }

  /** The last error stays after the machine is good again, with the time it first came, so a short problem can still be seen */
  private noteError(machineId: string, problem: string, now: Date): void {
    if (!problem) return;
    const history = this.historyOf(machineId);
    if (history.lastError?.text !== problem) history.lastError = { text: problem, time: now.toISOString() };
  }
}

/** One change of a machine: a log line, and an event for its health panel */
interface Note {
  level: 'info' | 'warn';
  message: string;
  details: Record<string, unknown>;
  tone: ConnectionEvent['tone'];
}

const good = (message: string, details: Record<string, unknown> = {}): Note => ({ level: 'info', message, details, tone: 'good' });
const bad = (message: string, details: Record<string, unknown>): Note => ({ level: 'warn', message, details, tone: 'bad' });

/** The reason detail of a log line: none when the machine gave no error */
const reasonOf = (problem: string) => ({ reason: problem || undefined });

/** The first result of a machine */
function firstNote(connected: boolean, problem: string): Note {
  return connected ? good('Machine connected', problem ? { problem } : {}) : bad('Machine cannot be reached', reasonOf(problem));
}

/** What changed since the last poll that was recorded. Nothing when the machine is as before. */
function notesOf(previous: MachineState | undefined, connected: boolean, errors: string[], now: Date): Note[] {
  const problem = errors.join('; ');
  if (!previous) return [firstNote(connected, problem)];
  if (previous.connected && !connected) return [bad('Machine went offline', reasonOf(problem))];
  if (!previous.connected && connected) {
    const online = good('Machine is online again', { offlineFor: durationText(previous.offlineSince, now) });
    return problem ? [online, bad('Machine reports a problem', { problem })] : [online];
  }
  if (isNewProblem(previous.errors, errors)) {
    return [connected
      ? bad('Machine reports a problem', { problem })
      : bad('Machine is still offline, for another reason', { reason: problem })];
  }
  if (connected && previous.errors.length > 0 && errors.length === 0) return [good('Machine problem is gone')];
  return [];
}

/**
 * True when the errors tell of another problem: none of them was there at the last poll.
 * A connector often adds a second message for the same cause (for example "Connection failed" next to
 * "Poll failed" on the next try), and that is not worth a line.
 */
export function isNewProblem(previous: string[], current: string[]): boolean {
  return current.length > 0 && !current.some(error => previous.includes(error));
}

/** "45s", "12m", "3h 5m" or "2d 4h": how long a machine was offline */
export function durationText(since: Date | null, now: Date): string | undefined {
  if (!since) return undefined;
  const seconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
