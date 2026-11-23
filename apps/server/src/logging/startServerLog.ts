import { stopOnCrash, type CrashOptions } from './crashHandlers.js';
import { ServerLog } from './ServerLog.js';

export interface ServerLogStart extends Pick<CrashOptions, 'target' | 'exit'> {
  environment?: NodeJS.ProcessEnv;
}

/**
 * Start the server log (in memory and in `dataFolder`/logs), for Settings > Diagnostics.
 * Then an error that nothing caught is logged and written to the file, and Chatter stops. Docker starts it again.
 * index.ts calls this at start-up. Tests give their own target and exit.
 */
export function startServerLog(dataFolder: string, { target, exit, environment = process.env }: ServerLogStart = {}) {
  const serverLog = ServerLog.forDataFolder(dataFolder, environment);
  const stopListening = serverLog.listen();
  stopOnCrash({ target, exit, flushLog: async () => serverLog.file?.close() });
  return { serverLog, stopListening };
}
