import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { FTPClient } from './FTPClient.js';
import { HOST, STOP_LIMIT_MS, startEndlessMachine, waitFor, type EndlessMachine } from './testSupport.js';

// When the user cancels a program download, Chatter must stop the transfer on the machine too.
// Else the machine sends the rest of the file to nobody, and its FTP connection stays busy.
//
// The fake machine (startEndlessMachine) sends a file that never ends.

/** Resolve when the output got its first bytes */
function firstBytes(output: PassThrough): Promise<void> {
  return new Promise(resolve => output.once('data', () => resolve()));
}

/** The number of times that the machine got `command` */
function countOf(machine: EndlessMachine, command: string): number {
  return machine.commands.filter(sent => sent === command).length;
}

/** The result of the download, or 'still running' when it does not end in STOP_LIMIT_MS */
function outcomeWithinLimit(download: Promise<void>): Promise<string> {
  return Promise.race([
    download.then(() => 'complete', (err: Error) => `failed: ${err.message}`),
    new Promise<string>(resolve => setTimeout(() => resolve('still running'), STOP_LIMIT_MS)),
  ]);
}

describe('FTPClient download that the user cancels', () => {
  let machine: EndlessMachine | undefined;
  let running: Promise<unknown> | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await machine?.close();
    // The machine closed its sockets, so a download that did not stop ends now
    await running?.catch(() => undefined);
    machine = undefined;
    running = undefined;
  });

  it.each([
    ['the raw RETR', false],
    ['the fallback download of basic-ftp', true],
  ])('stops %s and closes the connections to the machine', async (_name, refuseFirstPasv) => {
    machine = await startEndlessMachine({ refuseFirstPasv });
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();
    const started = firstBytes(output);

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await started;
    cancel.abort();

    expect(await outcomeWithinLimit(download)).toMatch(/^failed: FTP download error: /);
    await waitFor(() => machine!.openDataConnections() === 0 && machine!.openControlConnections() === 0);
    expect(machine.openDataConnections()).toBe(0);
    expect(machine.openControlConnections()).toBe(0);
  });

  it('does not try the fallback download after a cancel', async () => {
    machine = await startEndlessMachine();
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();
    const started = firstBytes(output);

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await started;
    cancel.abort();
    await outcomeWithinLimit(download);

    expect(machine.commands.filter(command => command === 'RETR')).toHaveLength(1);
  });

  it('does not connect to the machine when the download was cancelled before it started', async () => {
    machine = await startEndlessMachine();
    const cancel = new AbortController();
    cancel.abort();

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', new PassThrough(), cancel.signal);

    await expect(download).rejects.toThrow('FTP download error: ');
    expect(machine.commands).toEqual([]);
  });

  it('does not try the fallback download after a cancel that comes before the data', async () => {
    machine = await startEndlessMachine({ holdData: true });
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await waitFor(() => machine!.commands.includes('RETR'));
    expect(machine.commands).toContain('RETR');
    cancel.abort();

    expect(await outcomeWithinLimit(download)).toMatch(/^failed: FTP download error: /);
    expect(countOf(machine, 'USER')).toBe(1);
    expect(countOf(machine, 'RETR')).toBe(1);
  });

  it('stops a download that waits for a slow reader, clears its time limit, and does not try the fallback', async () => {
    const timeLimitMs = 123_456;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    machine = await startEndlessMachine();
    // Nothing reads the output, so it fills after the first chunk
    const output = new PassThrough({ highWaterMark: 1 });
    const cancel = new AbortController();

    const download = new FTPClient({ host: HOST, port: machine.port }, { timeLimitMs })
      .downloadFile('O1000', output, cancel.signal);
    running = download;
    await waitFor(() => output.writableNeedDrain);
    expect(output.writableNeedDrain).toBe(true);
    cancel.abort();

    expect(await outcomeWithinLimit(download)).toMatch(/^failed: FTP download error: /);
    await waitFor(() => machine!.openDataConnections() === 0 && machine!.openControlConnections() === 0);
    expect(machine.openDataConnections()).toBe(0);
    expect(machine.openControlConnections()).toBe(0);
    const timeLimitTimer = setTimeoutSpy.mock.results[setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === timeLimitMs)];
    expect(timeLimitTimer).toBeDefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timeLimitTimer.value);
    expect(countOf(machine, 'USER')).toBe(1);
    expect(countOf(machine, 'RETR')).toBe(1);
  });

  it('stops a download that waits for the reply after the end of the data', async () => {
    machine = await startEndlessMachine({ endWithoutReply: true });
    const output = new PassThrough();
    output.resume();
    const cancel = new AbortController();
    const started = firstBytes(output);

    const download = new FTPClient({ host: HOST, port: machine.port }).downloadFile('O1000', output, cancel.signal);
    running = download;
    await started;
    // The machine closed the data connection, so the client waits REPLY_AFTER_DATA_WAIT_MS for the 226 reply
    await waitFor(() => machine!.openDataConnections() === 0);
    expect(machine.openDataConnections()).toBe(0);
    cancel.abort();

    expect(await outcomeWithinLimit(download)).toMatch(/^failed: FTP download error: /);
    await waitFor(() => machine!.openControlConnections() === 0);
    expect(machine.openControlConnections()).toBe(0);
    expect(countOf(machine, 'RETR')).toBe(1);
  });
});
