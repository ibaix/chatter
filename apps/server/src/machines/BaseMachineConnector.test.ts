import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import type { FTPClient } from '../ftp/FTPClient.js';
import { BrotherConnector } from './brother/BrotherConnector.js';

/** Any connector, because reportPollTimeout comes from BaseMachineConnector */
function connector(): BrotherConnector {
  return new BrotherConnector({ id: 'm1', name: 'M', host: '127.0.0.1' });
}

describe('reportPollTimeout', () => {
  it('tells the user the time limit in seconds, and that Chatter connects again', () => {
    const machine = connector();

    machine.reportPollTimeout(10000);

    expect(machine.getStatus().errors[0]).toBe(
      'The machine did not answer all requests in 10 seconds. Chatter disconnected. It will connect again.',
    );
  });

  it('never tells the user 0 seconds for a time limit under one second', () => {
    const machine = connector();

    machine.reportPollTimeout(300);

    expect(machine.getStatus().errors[0]).toBe(
      'The machine did not answer all requests in 1 second. Chatter disconnected. It will connect again.',
    );
  });
});

describe('downloadFile', () => {
  it('gives the signal of the caller to the FTP client, so a cancel stops the download on the machine', async () => {
    const machine = connector();
    const downloadFile = vi.fn<FTPClient['downloadFile']>().mockResolvedValue(undefined);
    (machine as unknown as { ftpClient: Pick<FTPClient, 'downloadFile'> }).ftpClient = { downloadFile };
    const output = new PassThrough();
    const signal = new AbortController().signal;

    await machine.downloadFile('O1000', output, signal);

    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile.mock.calls[0][2]).toBe(signal);
  });
});

// The signal takes a waiting task out of the queue of the machine, for example when the browser leaves
describe.each([
  { name: 'listFiles', call: (machine: BrotherConnector, signal: AbortSignal) => machine.listFiles('/', signal), result: [] },
  { name: 'uploadFile', call: (machine: BrotherConnector, signal: AbortSignal) => machine.uploadFile('/O1000', 'O1000', true, signal), result: undefined },
  {
    name: 'uploadFiles',
    call: (machine: BrotherConnector, signal: AbortSignal) => machine.uploadFiles([{ remotePath: '/O1000', source: 'O1000' }], true, signal),
    result: { success: [], failed: [] },
  },
  { name: 'deleteFile', call: (machine: BrotherConnector, signal: AbortSignal) => machine.deleteFile('/O1000', signal), result: undefined },
] as const)('$name', ({ name, call, result }) => {
  it('gives the signal of the caller to the FTP client', async () => {
    const machine = connector();
    const task = vi.fn().mockResolvedValue(result);
    (machine as unknown as { ftpClient: Record<string, unknown> }).ftpClient = { [name]: task };
    const signal = new AbortController().signal;

    await call(machine, signal);

    expect(task).toHaveBeenCalledOnce();
    expect(task.mock.calls[0].at(-1)).toBe(signal);
  });
});
