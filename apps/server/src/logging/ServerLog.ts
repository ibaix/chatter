import path from 'node:path';
import { addLogListener } from './logger.js';
import { DebugSwitch } from './DebugSwitch.js';
import { LogBuffer } from './LogBuffer.js';
import { LogFile } from './LogFile.js';

/**
 * The copies of the server log that Settings > Diagnostics shows: the last lines in memory,
 * the log file in the data volume (it survives a restart), and the debug switch.
 */
export class ServerLog {
  readonly buffer: LogBuffer;
  /** The live log views that are open now (GET /logs/stream) */
  openStreams = 0;

  constructor(
    readonly file: LogFile | null = null,
    readonly debug = new DebugSwitch(),
    buffer = new LogBuffer(),
  ) {
    this.buffer = buffer;
  }

  /**
   * The log of the server, kept in `dataFolder`/logs. LOG_FILE=off keeps it only in memory,
   * for example on a computer where the data folder is on a slow disk.
   */
  static forDataFolder(dataFolder: string, environment: NodeJS.ProcessEnv = process.env): ServerLog {
    const isFileOff = environment.LOG_FILE?.trim().toLowerCase() === 'off';
    return new ServerLog(isFileOff ? null : new LogFile(path.join(dataFolder, 'logs', 'chatter.log')));
  }

  /** The log files, the old one first. None when the log is kept only in memory. */
  get filePaths(): string[] {
    return this.file?.filePaths ?? [];
  }

  /** Keep each line that the server writes from now on. Returns a function that stops it. */
  listen(): () => void {
    return addLogListener(entry => {
      this.buffer.add(entry);
      this.file?.write(entry.text);
    });
  }
}
