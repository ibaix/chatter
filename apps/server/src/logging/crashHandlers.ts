import { createLogger } from './logger.js';

const log = createLogger('server');

/** The longest wait for the log file before the process stops */
export const CRASH_FLUSH_TIME_LIMIT_MS = 2000;

export interface CrashOptions {
  /** The process that sends the crash events. Tests give their own. */
  target?: Pick<NodeJS.EventEmitter, 'on'>;
  /** Writes the last lines to the log file, so Settings > Diagnostics shows the crash after the restart */
  flushLog?: () => Promise<void>;
  exit?: (code: number) => void;
}

/**
 * An error that nothing caught leaves the server in an unknown state. So Chatter logs it and stops with code 1.
 * Docker then starts Chatter again ("restart: unless-stopped" in docker-compose.yml).
 */
export function stopOnCrash({ target = process, flushLog = async () => {}, exit = code => process.exit(code) }: CrashOptions = {}): void {
  let isStopping = false;
  const crash = (message: string) => (failure: unknown) => {
    log.error(message, failure instanceof Error ? { error: failure } : { reason: String(failure) });
    if (isStopping) return;
    isStopping = true;
    const timeLimit = new Promise<void>(resolve => setTimeout(resolve, CRASH_FLUSH_TIME_LIMIT_MS));
    void Promise.race([flushLog().catch(() => {}), timeLimit]).then(() => exit(1));
  };
  target.on('uncaughtException', crash('An error that nothing caught stops Chatter'));
  target.on('unhandledRejection', crash('A promise failed, and nothing caught the error. Chatter stops.'));
}
