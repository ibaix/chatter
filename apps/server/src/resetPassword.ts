/**
 * Make a new Admin, for when no Admin knows their password. It asks for the username and the password on the terminal.
 * The old Admin accounts are removed, and each browser is logged out. The users who are not Admins stay.
 * The first-run setup stays closed, so no other person on the network can make the Admin.
 *
 *   docker compose exec chatterbox npm run reset-password
 */
import 'dotenv/config';
import { runPasswordReset } from './auth/resetPasswordPrompt.js';
import { SessionStore } from './auth/sessionStore.js';
import { UserStore } from './auth/userStore.js';
import { ServerLog } from './logging/ServerLog.js';
import { closeDatabase, dataFolder, getDb } from './storage/database.js';

// The warning about the new Admin also goes to the log file that Settings > Diagnostics shows
const serverLog = ServerLog.forDataFolder(dataFolder());
const stopListening = serverLog.listen();
try {
  const done = await runPasswordReset({
    input: process.stdin, output: process.stdout, users: new UserStore(getDb()), sessions: new SessionStore(getDb()),
  });
  if (!done) process.exitCode = 1;
} finally {
  stopListening();
  await serverLog.file?.close();
  await closeDatabase();
}
