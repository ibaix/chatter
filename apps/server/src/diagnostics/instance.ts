import { randomBytes } from 'node:crypto';

/**
 * A random name of this server process. /api/health gives it, so the network scan can tell
 * this Chatter from another Chatter on the network. It changes at each start, and tells nothing about the computer.
 */
export const INSTANCE_ID = randomBytes(8).toString('hex');
