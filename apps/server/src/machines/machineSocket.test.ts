import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_DELAY_MS, tuneMachineSocket } from './machineSocket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tuneMachineSocket', () => {
  it('turns on TCP keepalive after 15 seconds with no traffic, so a dead connection is found when no poll runs', () => {
    const socket = new net.Socket();
    const keepAlive = vi.spyOn(socket, 'setKeepAlive');

    tuneMachineSocket(socket);

    expect(keepAlive).toHaveBeenCalledWith(true, KEEPALIVE_DELAY_MS);
    expect(KEEPALIVE_DELAY_MS).toBe(15_000);
    socket.destroy();
  });

  it('sends each small command at once, with no wait to join it with more data', () => {
    const socket = new net.Socket();
    const noDelay = vi.spyOn(socket, 'setNoDelay');

    tuneMachineSocket(socket);

    expect(noDelay).toHaveBeenCalledWith(true);
    socket.destroy();
  });
});
