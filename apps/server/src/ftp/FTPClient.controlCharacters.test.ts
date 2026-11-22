import { describe, it, expect, vi, beforeEach } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';

// The routes refuse these paths first. These tests prove that the FTP client also refuses them, so no other caller
// can add a second FTP command (for example DELE) with a line break in a path.

const mockAccess = vi.fn();
const mockSend = vi.fn();
const mockWrite = vi.fn();
const mockFtpClient = {
  access: mockAccess,
  send: mockSend,
  list: vi.fn().mockResolvedValue([]),
  cd: vi.fn(),
  pwd: vi.fn(),
  remove: vi.fn(),
  uploadFrom: vi.fn(),
  downloadTo: vi.fn(),
  close: vi.fn(),
  ftp: { verbose: false, socket: { write: mockWrite } },
};

vi.mock('basic-ftp', () => ({
  Client: vi.fn(function () { return mockFtpClient; }),
}));

// Imported after vi.mock so FTPClient gets the mock basic-ftp
import { FTPClient } from './FTPClient.js';

const CONTROL_CHARACTER_ERROR = 'cannot have a line break or another control character';
const BAD_PATHS = ['O1000\r\nDELE O1234', 'O1000\nDELE O1234', 'O1000\rDELE O1234', 'O1000\0', 'O1000\x7f'];

describe('FTPClient with a control character in a path', () => {
  let ftpClient: FTPClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({ code: 200, message: 'OK' });
    ftpClient = new FTPClient({ host: '192.168.1.100' });
  });

  /** Nothing went to the machine: no login, no command, and no raw write */
  function expectNothingSent() {
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  }

  it.each(BAD_PATHS)('refuses to download %j', async path => {
    await expect(ftpClient.downloadFile(path, new PassThrough())).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    expectNothingSent();
  });

  // The manual download writes RETR straight to the control socket, past the check of basic-ftp
  it('does not write a raw RETR with a line break when the passive data connection opens', async () => {
    const dataServer = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => dataServer.listen(0, '127.0.0.1', resolve));
    const { port } = dataServer.address() as net.AddressInfo;
    mockSend.mockImplementation(async (command: string) => (command === 'PASV'
      ? { code: 227, message: `227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})` }
      : { code: 200, message: 'OK' }));

    try {
      await expect(ftpClient.downloadFile('O1000\r\nDELE O1234', new PassThrough())).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    } finally {
      dataServer.close();
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it.each(BAD_PATHS)('refuses to upload to %j', async path => {
    await expect(ftpClient.uploadFile(path, 'G00', true)).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    expectNothingSent();
  });

  it.each(BAD_PATHS)('refuses to delete %j', async path => {
    await expect(ftpClient.deleteFile(path)).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    expectNothingSent();
  });

  it.each(BAD_PATHS)('refuses to list %j', async path => {
    await expect(ftpClient.listFiles(path)).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    expectNothingSent();
  });

  it.each(BAD_PATHS)('refuses the file tree of %j', async path => {
    await expect(ftpClient.getFileTree(path)).rejects.toThrow(CONTROL_CHARACTER_ERROR);
    expectNothingSent();
  });

  it('fails only the file of a batch whose path has a line break, and sends the other files', async () => {
    const result = await ftpClient.uploadFiles([
      { remotePath: 'O1000\r\nDELE O1234', source: 'G00' },
      { remotePath: 'O2000', source: 'G01' },
    ], true);

    expect(result.failed).toEqual([{ remotePath: 'O1000\r\nDELE O1234', error: expect.stringContaining(CONTROL_CHARACTER_ERROR) }]);
    expect(result.success).toEqual([{ remotePath: 'O2000' }]);
    expect(mockFtpClient.uploadFrom).toHaveBeenCalledTimes(1);
    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith(expect.anything(), 'O2000');
  });

  it('keeps a path with spaces and letters outside ASCII', async () => {
    await ftpClient.deleteFile('/PRG/Teil A €.nc');

    expect(mockFtpClient.remove).toHaveBeenCalledWith('PRG/Teil A €.nc');
  });
});
