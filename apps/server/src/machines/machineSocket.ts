import type net from 'net';

/**
 * TCP keepalive starts after 15 s with no traffic. A poll every 2 s keeps the connection busy, so the probes
 * go only when no poll runs: in the backoff of a failing machine (10 to 60 s), or while a poll waits.
 * Then a connection that is dead (a cable pulled, a machine turned off, a router that forgot it) gives an error,
 * not a silent wait. 15 s is less than the 30 s and 60 s backoff steps, so the probes come before the next poll.
 * The time between probes and their count are the defaults of the operating system.
 */
export const KEEPALIVE_DELAY_MS = 15_000;

/**
 * The socket options of a TCP connection to a machine control (Brother, Haas).
 * No delay: each command is a small write that waits for a reply. Without it, Nagle's algorithm can hold a
 * small write back until the control acknowledges the last one, which some controls do only after a delay.
 */
export function tuneMachineSocket(socket: net.Socket): void {
  socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
  socket.setNoDelay(true);
}
