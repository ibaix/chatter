import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import { FTPClient } from './FTPClient.js';
import { HOST, startEndlessMachine, type EndlessMachine } from './testSupport.js';

// Many CNC FTP servers accept only one session at a time. A second session can fail, or confuse the control.
// So FTPClient runs the FTP tasks of one machine one at a time: at most one control connection is open.
//
// The fake machine below counts its open control connections each time a command comes. The count does not depend on
// time: the client closes a connection before it opens the next one, so the machine sees the end of the old
// connection before the first command of the new one.

const PROGRAM_TEXT = 'O1000\nG00 X0 Y0\nM30\n';
/** The folders and their files. A folder name ends with "/". */
const FOLDERS: Record<string, string[]> = {
  '/': ['PROGRAMS/', 'SUBS/', 'O1000'],
  '/PROGRAMS': ['O2000', 'O3000'],
  '/SUBS': ['O9000'],
};

interface CountingMachine {
  port: number;
  /** The most control connections that were open when a command came */
  mostOpenAtCommand(): number;
  /** The number of logins (USER commands) */
  logins(): number;
  /** The text of each STOR, by its path */
  uploads: Map<string, string>;
  close(): Promise<void>;
}

function listen(server: net.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, HOST, () => resolve((server.address() as net.AddressInfo).port)));
}

function listingOf(folder: string): string {
  return (FOLDERS[folder] ?? []).map(name => (name.endsWith('/')
    ? `drwxr-xr-x 1 cnc cnc 0 Jan 01 12:00 ${name.slice(0, -1)}\r\n`
    : `-rw-r--r-- 1 cnc cnc ${PROGRAM_TEXT.length} Jan 01 12:00 ${name}\r\n`)).join('');
}

/** The folder of one login, and the data connection of its last PASV */
interface Session {
  folder: string;
  data?: Promise<net.Socket>;
}

/** One command, and what its handler needs */
interface Command {
  reply: (text: string) => void;
  session: Session;
  argument: string;
  /** The argument as a full path */
  path: string;
}

/** Send `text` on the data connection of the last PASV, and then (when `isReplySent`) the 226 reply */
function sendData(
  { reply, session }: Pick<Command, 'reply' | 'session'>,
  { text, isReplySent }: { text: string; isReplySent: boolean }
): void {
  reply('150 Opening data connection');
  void session.data?.then(data => data.end(text, () => isReplySent && reply('226 Transfer complete')));
}

function readAll(socket: net.Socket): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk));
  return new Promise(resolve => socket.on('end', () => resolve(Buffer.concat(chunks).toString())));
}

/**
 * A fake machine. Each PASV opens a new data port for one transfer. With `noListReply`, the machine sends the listing
 * but no reply to LIST, as some old machines do. Then the tree walk closes the connection and logs in again for the
 * next folder.
 */
async function startCountingMachine({ noListReply = false } = {}): Promise<CountingMachine> {
  const openControls = new Set<net.Socket>();
  const allSockets = new Set<net.Socket>();
  const uploads = new Map<string, string>();
  let mostOpen = 0;
  let loginCount = 0;

  const track = (socket: net.Socket) => {
    allSockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => allSockets.delete(socket));
  };

  /** What the machine does for each command. A command that is not here gets "200 OK". */
  const handlers: Record<string, (command: Command) => void> = {
    USER: ({ reply }) => {
      loginCount += 1;
      reply('331 Password');
    },
    PASS: ({ reply }) => reply('230 Logged in'),
    EPSV: ({ reply }) => reply('500 Not supported'),
    PWD: ({ reply, session }) => reply(`257 "${session.folder}"`),
    CWD: ({ reply, session, path }) => {
      session.folder = path.replace(/\/$/, '') || '/';
      reply(FOLDERS[session.folder] ? '250 OK' : '550 No such folder');
    },
    SIZE: ({ reply }) => reply(`213 ${PROGRAM_TEXT.length}`),
    DELE: ({ reply, path }) => reply(path === '/O1000' ? '250 Deleted' : '550 No such file'),
    PASV: ({ reply, session }) => {
      const dataServer = net.createServer();
      session.data = new Promise(resolve => dataServer.once('connection', socket => {
        track(socket);
        dataServer.close();
        resolve(socket);
      }));
      void listen(dataServer).then(port => reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`));
    },
    RETR: ({ reply, session }) => sendData({ reply, session }, { text: PROGRAM_TEXT, isReplySent: true }),
    LIST: ({ reply, session, argument, path }) => sendData({ reply, session }, {
      text: listingOf(argument === '' ? session.folder : path), isReplySent: !noListReply,
    }),
    STOR: ({ reply, session, path }) => {
      reply('150 Ready for data');
      void session.data?.then(readAll).then(text => {
        uploads.set(path, text);
        reply('226 Transfer complete');
      });
    },
  };

  const answer = (control: net.Socket, session: Session, line: string) => {
    const [word, ...rest] = line.split(' ');
    // basic-ftp sends "LIST -a <path>". The fake machine ignores the flags.
    const argument = rest.join(' ').replace(/^(-\S+\s*)+/, '');
    const path = argument.startsWith('/') ? argument : `${session.folder === '/' ? '' : session.folder}/${argument}`;
    const reply = (text: string) => control.write(`${text}\r\n`);
    mostOpen = Math.max(mostOpen, openControls.size);
    const handler = handlers[word.toUpperCase()] ?? (() => reply('200 OK'));
    handler({ reply, session, argument, path });
  };

  const controlServer = net.createServer(control => {
    track(control);
    openControls.add(control);
    // 'end' comes when the client closes its side; 'close' can come some time later
    const forget = () => openControls.delete(control);
    control.on('end', forget);
    control.on('close', forget);
    const session: Session = { folder: '/' };
    let buffered = '';
    control.on('data', chunk => {
      buffered += chunk.toString();
      const lines = buffered.split('\r\n');
      buffered = lines.pop() ?? '';
      lines.forEach(line => answer(control, session, line));
    });
    control.write('220 Counting machine\r\n');
  });
  const port = await listen(controlServer);

  return {
    port,
    mostOpenAtCommand: () => mostOpen,
    logins: () => loginCount,
    uploads,
    async close() {
      allSockets.forEach(socket => socket.destroy());
      await new Promise(resolve => controlServer.close(resolve));
    },
  };
}

function collect(output: PassThrough): () => string {
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  return () => text;
}

/** Resolve when the output got its first bytes */
function firstBytes(output: PassThrough): Promise<void> {
  return new Promise(resolve => output.once('data', () => resolve()));
}

function namesOf(nodes: Array<{ name: string; children?: unknown[] }>): string[] {
  return nodes.map(node => node.name);
}

describe('FTPClient: one FTP session at a time for each machine', () => {
  let machine: CountingMachine | undefined;

  afterEach(async () => {
    await machine?.close();
    machine = undefined;
  });

  function clientOf(counting: CountingMachine): FTPClient {
    return new FTPClient({ host: HOST, port: counting.port });
  }

  it('runs two downloads one after the other, over one control connection at a time', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);
    const outputs = [new PassThrough(), new PassThrough()];
    const texts = outputs.map(collect);

    await Promise.all(outputs.map(output => client.downloadFile('O1000', output)));

    expect(texts.map(text => text())).toEqual([PROGRAM_TEXT, PROGRAM_TEXT]);
    expect(machine.logins()).toBe(2);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  it('does not run a tree walk and an upload at the same time', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);

    const [tree] = await Promise.all([
      client.readFileTree('/', 2),
      client.uploadFile('/PROGRAMS/O4000', 'O4000\nM30\n'),
    ]);

    expect(namesOf(tree.nodes)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    expect(machine.uploads.get('/PROGRAMS/O4000')).toBe('O4000\nM30\n');
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  it('runs a list, a delete and an upload batch one at a time', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);

    const [files, , batch] = await Promise.all([
      client.listFiles('/'),
      client.deleteFile('/O1000'),
      client.uploadFiles([{ remotePath: '/SUBS/O9100', source: 'O9100\nM99\n' }]),
    ]);

    expect(files.map(file => file.name)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    expect(batch.success).toEqual([{ remotePath: 'SUBS/O9100' }]);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  it('starts the next task after a task that fails', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);

    const [deleted, listed] = await Promise.allSettled([client.deleteFile('/MISSING'), client.listFiles('/SUBS')]);

    expect(deleted.status).toBe('rejected');
    expect((deleted as PromiseRejectedResult).reason.message).toMatch(/^FTP delete error: 550 No such file/);
    expect(listed.status).toBe('fulfilled');
    expect((listed as PromiseFulfilledResult<Array<{ name: string }>>).value.map(file => file.name)).toEqual(['O9000']);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  it('gives two requests for the same tree one walk, and one login', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);

    const [first, second] = await Promise.all([client.readFileTree('/', 2), client.readFileTree('/', 2)]);

    expect(second).toBe(first);
    expect(machine.logins()).toBe(1);
  });

  it('runs a walk of another tree after the first walk, not at the same time', async () => {
    machine = await startCountingMachine();
    const client = clientOf(machine);

    const [deep, flat] = await Promise.all([client.readFileTree('/', 2), client.readFileTree('/', 1)]);

    expect(namesOf(deep.nodes[0].children ?? [])).toEqual(['O2000', 'O3000']);
    expect(flat.nodes[0].children).toBeUndefined();
    expect(machine.logins()).toBe(2);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  // With no reply to LIST, the walk closes the connection and logs in again for each folder. Each new login must stay
  // in the turn of the walk, so a download does not log in between two folders.
  it('keeps the new logins of a tree walk in its own turn', async () => {
    machine = await startCountingMachine({ noListReply: true });
    const client = clientOf(machine);
    const output = new PassThrough();
    const text = collect(output);

    const [tree] = await Promise.all([client.readFileTree('/', 2), client.downloadFile('O1000', output)]);

    expect(namesOf(tree.nodes[1].children ?? [])).toEqual(['O9000']);
    expect(text()).toBe(PROGRAM_TEXT);
    // The walk: one login, then one more for each of its 2 subfolders. Then the download.
    expect(machine.logins()).toBe(4);
    expect(machine.mostOpenAtCommand()).toBe(1);
  }, 15_000);
});

describe('FTPClient download that stops while another task waits', () => {
  let endless: EndlessMachine | undefined;

  afterEach(async () => {
    await endless?.close();
    endless = undefined;
  });

  function loginsOn(machine: EndlessMachine): number {
    return machine.commands.filter(command => command === 'USER').length;
  }

  it('starts the waiting download when the user cancels the running one', async () => {
    // The fake machine sends a file that never ends, so the first download runs until the cancel
    endless = await startEndlessMachine();
    const client = new FTPClient({ host: HOST, port: endless.port });
    const firstOutput = new PassThrough();
    const secondOutput = new PassThrough();
    firstOutput.resume();
    const cancelFirst = new AbortController();
    const cancelSecond = new AbortController();
    const firstStarted = firstBytes(firstOutput);
    const secondStarted = firstBytes(secondOutput);

    const first = client.downloadFile('O1000', firstOutput, cancelFirst.signal);
    const second = client.downloadFile('O2000', secondOutput, cancelSecond.signal);
    await firstStarted;
    expect(loginsOn(endless)).toBe(1);
    expect(endless.openControlConnections()).toBe(1);

    cancelFirst.abort();
    await expect(first).rejects.toThrow('FTP download error: ');
    await secondStarted;

    expect(loginsOn(endless)).toBe(2);
    expect(endless.openControlConnections()).toBe(1);
    cancelSecond.abort();
    await expect(second).rejects.toThrow('FTP download error: ');
  });

  it('removes a waiting download that the user cancels, and does not connect for it', async () => {
    endless = await startEndlessMachine();
    const client = new FTPClient({ host: HOST, port: endless.port });
    const firstOutput = new PassThrough();
    firstOutput.resume();
    const firstStarted = firstBytes(firstOutput);
    const cancelFirst = new AbortController();
    const cancelWaiting = new AbortController();

    const first = client.downloadFile('O1000', firstOutput, cancelFirst.signal);
    const waiting = client.downloadFile('O2000', new PassThrough(), cancelWaiting.signal);
    await firstStarted;
    cancelWaiting.abort(new Error('The browser left'));

    await expect(waiting).rejects.toThrow('FTP download error: The browser left');
    cancelFirst.abort();
    await expect(first).rejects.toThrow('FTP download error: ');
    expect(loginsOn(endless)).toBe(1);
  });
});
