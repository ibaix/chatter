import { createWriteStream, mkdirSync, openSync, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';

/** The size of one log file. With the old file, the log takes at most 2 MB on the card. */
const LOG_FILE_BYTES = 1024 * 1024;
/** Lines that wait for the card. When the card is too slow, more lines are dropped, so the memory stays low. */
const MAX_PENDING_BYTES = 256 * 1024;

/**
 * The server log in a file in the data volume, so the lines survive a restart of Chatter or of the Pi.
 * When the file is full, it becomes `<name>.1` (the old one is deleted), and a new file starts.
 * A file that cannot be written does not stop the server: the log goes on in the console and in memory.
 */
export class LogFile {
  private stream: WriteStream | null = null;
  private size = 0;
  private droppedLines = 0;
  private isBroken = false;
  /** The old files that still get their last lines */
  private readonly endings = new Set<Promise<void>>();

  constructor(readonly filePath: string, private readonly maxBytes = LOG_FILE_BYTES) {}

  /** The old file first, then the current file */
  get filePaths(): string[] {
    return [`${this.filePath}.1`, this.filePath];
  }

  write(text: string): void {
    if (this.isBroken) return;
    const line = `${text}\n`;
    const bytes = Buffer.byteLength(line);
    const stream = this.openStream();
    if (!stream) return;
    if (stream.writableLength > MAX_PENDING_BYTES) {
      this.droppedLines++;
      return;
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    const marker = this.droppedLines > 0 ? `[${this.droppedLines} lines dropped: the card was too slow]\n` : '';
    this.droppedLines = 0;
    this.stream!.write(marker + line);
    this.size += Buffer.byteLength(marker) + bytes;
  }

  /** Ends the file. The promise ends when each line is on the card. */
  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream) this.end(stream);
    await Promise.all(this.endings);
  }

  private end(stream: WriteStream): void {
    const ending = new Promise<void>(resolve => stream.end(resolve)).then(() => {
      this.endings.delete(ending);
    });
    this.endings.add(ending);
  }

  private openStream(): WriteStream | null {
    if (this.stream) return this.stream;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.size = fileSize(this.filePath);
      // Opened at once (not later, as createWriteStream does), so a rotate always finds the file
      const stream = createWriteStream('', { fd: openSync(this.filePath, 'a', 0o600) });
      stream.on('error', error => this.stop(error));
      this.stream = stream;
      return stream;
    } catch (error) {
      this.stop(error);
      return null;
    }
  }

  /** The open file keeps its lines under the old name. Node writes them before it closes the file. */
  private rotate(): void {
    const old = this.stream;
    this.stream = null;
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (old) this.end(old);
      this.stop(error);
      return;
    }
    if (old) this.end(old);
    this.size = 0;
    this.openStream();
  }

  private stop(error: unknown): void {
    if (this.isBroken) return;
    this.isBroken = true;
    this.stream = null;
    // Not with the logger: its lines come back here
    process.stderr.write(`The log file ${this.filePath} cannot be written, so the log is not kept in a file: ${String(error)}\n`);
  }
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
