import { LOG_LEVELS, type LogEntry, type LogLevel } from './logger.js';

/**
 * The last lines of the server log, in memory, for Settings > Diagnostics (download and live view).
 * A Pi can have 512 MB of RAM, so the buffer has a limit on lines and on characters, and drops the oldest lines.
 */
const LOG_BUFFER_LIMITS = {
  /** The most lines that the buffer keeps */
  lines: 2000,
  /** The most characters of all lines together: 600 000 characters is less than 1 MB of text */
  characters: 600_000,
  /** A longer line (for example a long stack) is cut to this length */
  lineCharacters: 4000,
};

/** Which lines to give: this level and higher, of one machine, from a time */
export interface LogFilter {
  level?: LogLevel;
  machine?: string;
  since?: Date;
}

export type LogBufferListener = (entry: LogEntry) => void;

const CUT_MARK = ' …[cut]';

export function matchesFilter(entry: LogEntry, { level, machine, since }: LogFilter): boolean {
  if (level && LOG_LEVELS.indexOf(entry.level) < LOG_LEVELS.indexOf(level)) return false;
  if (machine && entry.machine !== machine) return false;
  if (since && entry.time.getTime() < since.getTime()) return false;
  return true;
}

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private characters = 0;
  private readonly listeners = new Set<LogBufferListener>();

  constructor(private readonly limits = LOG_BUFFER_LIMITS) {}

  add(entry: LogEntry): void {
    const text = entry.text.length > this.limits.lineCharacters
      ? entry.text.slice(0, this.limits.lineCharacters - CUT_MARK.length) + CUT_MARK
      : entry.text;
    const kept = { ...entry, text };
    this.entries.push(kept);
    this.characters += text.length;
    while (this.entries.length > this.limits.lines || this.characters > this.limits.characters) {
      this.characters -= this.entries.shift()!.text.length;
    }
    for (const listener of this.listeners) listener(kept);
  }

  /** The kept lines that match the filter, oldest first */
  lines(filter: LogFilter = {}): LogEntry[] {
    return this.entries.filter(entry => matchesFilter(entry, filter));
  }

  /** The kept lines as one text, one line after the other */
  text(filter: LogFilter = {}): string {
    return this.lines(filter).map(entry => `${entry.text}\n`).join('');
  }

  /** Tell `listener` each new line. Returns a function that stops it. */
  subscribe(listener: LogBufferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
