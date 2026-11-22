import type net from 'net';

/**
 * TCP keepalive sends its first probe after 15 s with no traffic on an open connection. With the default poll
 * every 2 s, a connection is never idle for so long, so no probe goes: the time limit of each command finds a
 * dead connection. The probes help only on an open connection with no traffic for 15 s or more, for example
 * with a poll interval longer than 15 s. Then a dead connection (a cable pulled, a machine turned off, a router
 * that forgot it) gives an error before the next command, not a silent wait.
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
