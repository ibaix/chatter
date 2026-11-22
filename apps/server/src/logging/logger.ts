/**
 * The server log: one line for each event, with a level, the part of the server that wrote it,
 * and the details as key=value pairs (or as JSON).
 *
 * LOG_LEVEL   debug, info (the default), warn or error. Lines below the level are not written.
 * LOG_FORMAT  text (the default), or json for one JSON object on each line, for a log collector.
 *
 * Docker keeps what the server writes: `docker logs chatterbox`. docker-compose.yml limits its size.
 */

import { redactContext, redactText } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export type LogFormat = 'text' | 'json';

/** The details of one event, for example { machine: 'm1' }. An Error value is written with its message and the messages of its causes. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that adds these details to each of its lines, for example the machine */
  child(context: LogContext): Logger;
}

export interface LogLine {
  time: Date;
  level: LogLevel;
  component: string;
  message: string;
  context: LogContext;
}

/** Where the lines go. Warnings and errors go to stderr, so they stand out in `docker logs`. */
export type LogSink = (level: LogLevel, text: string) => void;

const consoleSink: LogSink = (level, text) => {
  if (level === 'warn' || level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
};

/** One written line, for a listener such as the log buffer of Settings > Diagnostics. The secrets are already hidden. */
export interface LogEntry {
  time: Date;
  level: LogLevel;
  component: string;
  /** The machine ID of the line, when it has one */
  machine?: string;
  /** The line as the sink got it */
  text: string;
}

export type LogListener = (entry: LogEntry) => void;
const listeners = new Set<LogListener>();

/** Give each written line also to `listener`. Returns a function that stops it. */
export function addLogListener(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The level that is in use now */
export function currentLogLevel(): LogLevel {
  return settings.level;
}

interface LogSettings {
  level: LogLevel;
  format: LogFormat;
  sink: LogSink;
  now: () => Date;
}

/** A value of LOG_LEVEL that is not a level gives the default, so a typo never stops the server */
export function logLevelFrom(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(level as LogLevel) ? level as LogLevel : 'info';
}

export function logFormatFrom(value: string | undefined): LogFormat {
  return value?.trim().toLowerCase() === 'json' ? 'json' : 'text';
}

const settings: LogSettings = {
  level: logLevelFrom(process.env.LOG_LEVEL),
  format: logFormatFrom(process.env.LOG_FORMAT),
  sink: consoleSink,
  now: () => new Date(),
};

/** Change where and how the log is written. Tests use it to read the lines. Returns the old settings. */
export function configureLogging(changes: Partial<LogSettings>): LogSettings {
  const old = { ...settings };
  Object.assign(settings, changes);
  return old;
}

/** The logger of one part of the server, for example createLogger('poller') */
export function createLogger(component: string, context: LogContext = {}): Logger {
  const write = (level: LogLevel, message: string, extra?: LogContext) => {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(settings.level)) return;
    // The secrets are hidden first, so no copy of the line (console, buffer, file) holds them
    const line: LogLine = { time: settings.now(), level, component, message, context: redactContext({ ...context, ...extra }) };
    const text = redactText(settings.format === 'json' ? jsonLine(line) : textLine(line));
    settings.sink(level, text);
    const machine = typeof line.context.machine === 'string' ? line.context.machine : undefined;
    for (const listener of listeners) {
      try {
        listener({ time: line.time, level, component, machine, text });
      } catch {
        // A listener that fails must not stop the log
      }
    }
  };
  return {
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    child: extra => createLogger(component, { ...context, ...extra }),
  };
}

/** `2026-11-12T10:00:00.000Z WARN  [poller] Machine is offline machine=m1 reason="Connection refused"` */
export function textLine({ time, level, component, message, context }: LogLine): string {
  const details = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${textValue(value)}`);
  const stack = errorStack(level, context);
  const text = [time.toISOString(), level.toUpperCase().padEnd(5), `[${component}]`, message, ...details].join(' ');
  return stack ? `${text}\n${stack}` : text;
}

export function jsonLine({ time, level, component, message, context }: LogLine): string {
  const details = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, jsonValue(value)]));
  return JSON.stringify({ time: time.toISOString(), level, component, msg: message, ...details });
}

/** Words with spaces get quotes, so each pair stays one token */
function textValue(value: unknown): string {
  const text = value instanceof Error ? errorText(value) : typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return /[\s"=]/.test(text) || text === '' ? JSON.stringify(text) : text;
}

function jsonValue(value: unknown): unknown {
  return value instanceof Error ? errorJson(value, new Set()) : value;
}

/** The error, then each error that caused it. It stops at a cause that repeats, and after 5 causes. */
function causeChain(error: Error): unknown[] {
  const chain: unknown[] = [error];
  let cause = error.cause;
  while (cause !== undefined && !chain.includes(cause) && chain.length <= 5) {
    chain.push(cause);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return chain;
}

/** `FTP connection error; cause: Login failed; cause: Connection refused` */
function errorText(error: Error): string {
  return causeChain(error)
    .map(item => (item instanceof Error ? item.message : String(item)))
    .join('; cause: ');
}

function errorJson(error: Error, seen: Set<Error>): unknown {
  seen.add(error);
  const { cause } = error;
  const causeJson = cause instanceof Error ? (seen.has(cause) || seen.size > 5 ? undefined : errorJson(cause, seen)) : cause;
  return { message: error.message, stack: error.stack, ...(causeJson === undefined ? {} : { cause: causeJson }) };
}

/**
 * The stack of an error in the details: always on an error line, which is something unexpected,
 * and on other lines only at the debug level, because "connection refused" needs no stack.
 */
function errorStack(level: LogLevel, context: LogContext): string | undefined {
  if (level !== 'error' && settings.level !== 'debug') return undefined;
  const error = Object.values(context).find((value): value is Error => value instanceof Error);
  if (!error) return undefined;
  const causes = causeChain(error)
    .slice(1)
    .filter((cause): cause is Error => cause instanceof Error)
    .map(cause => `Caused by: ${cause.stack ?? cause.message}`);
  return [error.stack?.split('\n').slice(1).join('\n'), ...causes].filter(Boolean).join('\n') || undefined;
}
