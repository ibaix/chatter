import type { Logger } from '../logging/logger.js';
import { sizeText } from '../http/sizeText.js';

/**
 * A reply of a machine is larger than the limit of its reader. The reader stops, so a broken control, or another
 * device at the address of a machine, cannot fill the memory of the Pi with an endless reply.
 */
export class ReplyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The machine sent a reply larger than ${sizeText(maxBytes)}. Chatter stopped reading it and closed the connection.`);
    this.name = 'ReplyTooLargeError';
  }
}

/** Write one warning with the machine and the limit, and give the error */
export function warnReplyTooLarge(log: Logger, machineId: string, error: ReplyTooLargeError): ReplyTooLargeError {
  log.warn('The machine sent a reply larger than the limit. Chatter closed the connection.', {
    machine: machineId,
    limitBytes: error.maxBytes,
  });
  return error;
}
