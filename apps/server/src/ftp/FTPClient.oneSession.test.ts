import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { PassThrough } from 'stream';
import { FTPClient } from './FTPClient.js';
import { MachineBusyError, MAX_WAITING_TASKS } from './sessionQueue.js';
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
  /** The first word of each command that the machine got */
  commands: string[];
  /** With `holdStor`: send the 226 reply of each held STOR, and of each later STOR at once */
  releaseStor(): void;
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
 * next folder. With `holdStor`, the machine reads each upload, but sends no 226 reply until the test calls
 * releaseStor(). So an upload keeps the turn of the machine.
 */
async function startCountingMachine({ noListReply = false, holdStor = false } = {}): Promise<CountingMachine> {
  const openControls = new Set<net.Socket>();
  const allSockets = new Set<net.Socket>();
  const uploads = new Map<string, string>();
  const commands: string[] = [];
  let mostOpen = 0;
  let loginCount = 0;
  let release: () => void = () => undefined;
  const released = holdStor ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();

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
      if (path.startsWith('/LOCKED/')) {
        reply('550 Permission denied');
        return;
      }
      reply('150 Ready for data');
      void session.data?.then(readAll).then(async text => {
        uploads.set(path, text);
        await released;
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
    commands.push(word.toUpperCase());
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
    commands,
    releaseStor: () => release(),
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

/** The text of a task that did not start, because the queue of the machine is full */
const BUSY_TEXT = 'The machine is busy with other file tasks. Try again later.';

/**
 * Resolve when the condition is true, or fail after 2 s. It uses setImmediate and Date, which the fake timers of
 * these tests do not change.
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition did not become true in 2 s');
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** A download of an endless file that keeps the turn of the machine until the test cancels it */
function startHeldDownload(client: FTPClient) {
  const output = new PassThrough();
  const started = firstBytes(output);
  output.resume();
  const cancel = new AbortController();
  const done = client.downloadFile('O1000', output, cancel.signal).catch((err: Error) => err);
  return { started, cancel, done };
}

/** The error of a task, or 'fulfilled' */
function outcomeOf(task: Promise<unknown>): Promise<unknown> {
  return task.then(() => 'fulfilled', (err: unknown) => err);
}

describe('FTPClient tasks that wait for a busy machine', () => {
  let endless: EndlessMachine | undefined;
  let machine: CountingMachine | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await endless?.close();
    await machine?.close();
    endless = undefined;
    machine = undefined;
  });

  const loginsOn = (busy: EndlessMachine) => busy.commands.filter(command => command === 'USER').length;

  // A MachineBusyError becomes a 503 in the route. With "FTP ... error" in front, it would be a 500 with a stack.
  it('gives each kind of task the busy error, with its own text, when the queue of the machine is full', async () => {
    endless = await startEndlessMachine();
    const client = new FTPClient({ host: HOST, port: endless.port });
    const running = startHeldDownload(client);
    await running.started;
    const waiting = Array.from({ length: MAX_WAITING_TASKS }, () => {
      const cancel = new AbortController();
      return { cancel, done: outcomeOf(client.downloadFile('O2000', new PassThrough(), cancel.signal)) };
    });

    const errors = await Promise.all([
      client.uploadFiles([{ remotePath: '/SUBS/O9100', source: 'O9100\nM99\n' }]),
      client.listFiles('/'),
      client.uploadFile('/SUBS/O9100', 'O9100\nM99\n'),
      client.deleteFile('/O1000'),
      client.readFileTree('/', 2),
    ].map(outcomeOf));

    for (const err of errors) {
      expect(err).toBeInstanceOf(MachineBusyError);
      expect((err as Error).message).toBe(BUSY_TEXT);
    }
    waiting.forEach(task => task.cancel.abort());
    running.cancel.abort();
    await Promise.all([running.done, ...waiting.map(task => task.done)]);
    expect(loginsOn(endless)).toBe(1);
  });

  // The connector keeps its FTPClient when the user changes the machine settings. A waiting task must use the new
  // address, so it does not send the saved password to the old one.
  it('sends a waiting task to the new address after a settings change', async () => {
    endless = await startEndlessMachine();
    machine = await startCountingMachine();
    const client = new FTPClient({ host: HOST, port: endless.port });
    const running = startHeldDownload(client);
    await running.started;

    const listed = client.listFiles('/');
    client.updateConfig({ port: machine.port });
    running.cancel.abort();
    await running.done;

    expect((await listed).map(file => file.name)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    expect(machine.logins()).toBe(1);
    expect(loginsOn(endless)).toBe(1);
  });

  it('starts the next task after an upload that the machine refuses in its turn', async () => {
    machine = await startCountingMachine();
    const client = new FTPClient({ host: HOST, port: machine.port });

    const refused = outcomeOf(client.uploadFile('/LOCKED/O9100', 'O9100\nM99\n', true));
    // The upload has its turn, so the list waits for it
    await until(() => machine?.logins() === 1);
    const listed = await client.listFiles('/SUBS');
    const upload = await refused;

    expect((upload as Error).message).toMatch(/^FTP upload error: 550 Permission denied/);
    expect(listed.map(file => file.name)).toEqual(['O9000']);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  // A browser that leaves while its task waits must not get a task on the machine later, for example an upload
  it.each([
    { name: 'a list', start: (client: FTPClient, signal: AbortSignal) => client.listFiles('/', signal) },
    { name: 'a tree walk', start: (client: FTPClient, signal: AbortSignal) => client.readFileTree('/', 2, signal) },
    { name: 'an upload', start: (client: FTPClient, signal: AbortSignal) => client.uploadFile('/O9100', 'O9100\n', true, signal) },
    {
      name: 'an upload batch',
      start: (client: FTPClient, signal: AbortSignal) => client.uploadFiles([{ remotePath: '/O9100', source: 'O9100\n' }], true, signal),
    },
    { name: 'a delete', start: (client: FTPClient, signal: AbortSignal) => client.deleteFile('/O1000', signal) },
  ])('removes $name that waits when its signal aborts, and does not connect for it', async ({ start }) => {
    endless = await startEndlessMachine();
    const client = new FTPClient({ host: HOST, port: endless.port });
    const running = startHeldDownload(client);
    await running.started;
    const cancel = new AbortController();

    const task = outcomeOf(start(client, cancel.signal));
    cancel.abort(new Error('The browser left'));

    expect(((await task) as Error).message).toContain('The browser left');
    running.cancel.abort();
    await running.done;
    // The next task after the cancelled one gets its turn
    const after = startHeldDownload(client);
    await after.started;
    after.cancel.abort();
    await after.done;
    expect(loginsOn(endless)).toBe(2);
    expect(endless.commands).not.toContain('STOR');
    expect(endless.commands).not.toContain('DELE');
  });

  it('stops a running upload when its signal aborts, and starts the next task', async () => {
    machine = await startCountingMachine({ holdStor: true });
    const client = new FTPClient({ host: HOST, port: machine.port });
    const cancel = new AbortController();

    const upload = outcomeOf(client.uploadFile('/PROGRAMS/O4000', 'O4000\nM30\n', true, cancel.signal));
    await until(() => machine?.uploads.has('/PROGRAMS/O4000') === true);
    const listed = client.listFiles('/SUBS');
    cancel.abort(new Error('The browser left'));

    expect(((await upload) as Error).message).toBe('FTP upload error: The browser left');
    expect((await listed).map(file => file.name)).toEqual(['O9000']);
    expect(machine.mostOpenAtCommand()).toBe(1);
  });

  // An upload keeps the turn of the machine. A control that never confirms it must not block the other tasks forever.
  it('stops an upload at its time limit, and starts the next task', async () => {
    machine = await startCountingMachine({ holdStor: true });
    const client = new FTPClient({ host: HOST, port: machine.port }, { uploadTimeLimitMs: 60_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const upload = outcomeOf(client.uploadFile('/PROGRAMS/O4000', 'O4000\nM30\n', true));
    await until(() => machine?.uploads.has('/PROGRAMS/O4000') === true);
    const listed = client.listFiles('/SUBS');
    vi.advanceTimersByTime(59_999);
    expect(machine.logins()).toBe(1);
    vi.advanceTimersByTime(1);

    expect(((await upload) as Error).message).toBe('FTP upload error: The upload took too long. Chatter stops an upload after 1 minute.');
    expect((await listed).map(file => file.name)).toEqual(['O9000']);
  });

  it('fails each file of a batch that the time limit stopped', async () => {
    machine = await startCountingMachine({ holdStor: true });
    const client = new FTPClient({ host: HOST, port: machine.port }, { uploadTimeLimitMs: 60_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const batch = client.uploadFiles([
      { remotePath: '/PROGRAMS/O4000', source: 'O4000\n' },
      { remotePath: '/PROGRAMS/O5000', source: 'O5000\n' },
    ], true);
    await until(() => machine?.uploads.has('/PROGRAMS/O4000') === true);
    vi.advanceTimersByTime(60_000);

    const tooSlow = 'The upload took too long. Chatter stops an upload after 1 minute.';
    expect(await batch).toEqual({
      success: [],
      failed: [{ remotePath: 'PROGRAMS/O4000', error: tooSlow }, { remotePath: 'PROGRAMS/O5000', error: tooSlow }],
    });
    expect(machine.uploads.has('/PROGRAMS/O5000')).toBe(false);
  });

  // The download time limit is for the transfer. The wait for the turn must not use it up.
  it('starts the time limit of a download when the download gets its turn', async () => {
    endless = await startEndlessMachine();
    const client = new FTPClient({ host: HOST, port: endless.port, timeoutMs: 600_000 }, { timeLimitMs: 60_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = startHeldDownload(client);
    await first.started;
    const secondOutput = new PassThrough();
    let hasSecondData = false;
    secondOutput.on('data', () => { hasSecondData = true; });
    const cancelSecond = new AbortController();
    const second = outcomeOf(client.downloadFile('O2000', secondOutput, cancelSecond.signal));
    let isSecondDone = false;
    void second.then(() => { isSecondDone = true; });

    vi.advanceTimersByTime(60_000);

    expect(((await first.done) as Error).message).toBe('FTP download error: The download took too long. Chatter stops a download after 1 minute.');
    await until(() => hasSecondData || isSecondDone);
    expect(hasSecondData).toBe(true);
    cancelSecond.abort();
    await second;
  });
});

describe('FTPClient tree walks of a busy machine', () => {
  let machine: CountingMachine | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await machine?.close();
    machine = undefined;
  });

  /** A machine whose upload keeps the turn until the test calls releaseStor() */
  async function busyMachine() {
    const counting = await startCountingMachine({ holdStor: true });
    machine = counting;
    const client = new FTPClient({ host: HOST, port: counting.port });
    const upload = client.uploadFile('/PROGRAMS/O4000', 'O4000\nM30\n', true);
    await until(() => counting.uploads.has('/PROGRAMS/O4000'));
    return { client, counting, upload };
  }

  // The walk stops at MAX_TREE_DEPTH (5), so a deeper request is the same walk
  it('gives a request for a deeper tree than the limit the same walk', async () => {
    machine = await startCountingMachine();
    const client = new FTPClient({ host: HOST, port: machine.port });

    const [atLimit, deeper] = await Promise.all([client.readFileTree('/', 5), client.readFileTree('/', 9)]);

    expect(deeper).toBe(atLimit);
    expect(machine.logins()).toBe(1);
  });

  // Each role can ask for a tree, and each walk can take minutes. Walks of many folders that wait must not fill the
  // queue, so the sends of an Operator can still wait for their turn.
  it('lets only two walks of different trees wait, and refuses the next one at once', async () => {
    const { client, counting, upload } = await busyMachine();

    const waitingWalk = client.readFileTree('/', 2);
    const sameWalk = client.readFileTree('/', 2);
    const secondWalk = client.readFileTree('/SUBS', 1);
    const thirdWalk = outcomeOf(client.readFileTree('/PROGRAMS', 1));
    const listed = client.listFiles('/SUBS');

    const refused = await thirdWalk;
    expect(refused).toBeInstanceOf(MachineBusyError);
    expect((refused as Error).message).toBe(BUSY_TEXT);
    counting.releaseStor();
    await upload;
    const walked = await waitingWalk;
    expect(namesOf(walked.nodes)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    expect(await sameWalk).toBe(walked);
    expect(namesOf((await secondWalk).nodes)).toEqual(['O9000']);
    expect((await listed).map(file => file.name)).toEqual(['O9000']);
    // The upload, the two walks and the list
    expect(counting.logins()).toBe(4);
  });

  it('gives the walk to the callers that stay, when one caller leaves', async () => {
    const { client, counting, upload } = await busyMachine();
    const leave = new AbortController();

    const left = outcomeOf(client.readFileTree('/', 2, leave.signal));
    const stays = client.readFileTree('/', 2, new AbortController().signal);
    leave.abort(new Error('The browser left'));

    expect(((await left) as Error).message).toBe('The browser left');
    counting.releaseStor();
    await upload;
    expect(namesOf((await stays).nodes)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    expect(counting.logins()).toBe(2);
  });

  // A walk that runs must also stop when each caller left. It must not log in again for the next folder, and it must
  // give the turn to the next task. The fake timers stop the 1 s wait after the listing, so the walk is still in its
  // first folder when the caller leaves.
  it('stops a running walk when each caller left, with no new login, and starts the next task', async () => {
    machine = await startCountingMachine({ noListReply: true });
    const counting = machine;
    const client = new FTPClient({ host: HOST, port: counting.port });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const leave = new AbortController();
    const output = new PassThrough();
    const text = collect(output);

    const walk = outcomeOf(client.readFileTree('/', 2, leave.signal));
    await until(() => counting.commands.includes('LIST'));
    const download = client.downloadFile('O1000', output);
    leave.abort(new Error('The browser left'));

    expect(((await walk) as Error).message).toBe('The browser left');
    await download;
    expect(text()).toBe(PROGRAM_TEXT);
    // The walk and the download only
    expect(counting.logins()).toBe(2);
    expect(counting.commands.filter(command => command === 'LIST')).toHaveLength(1);
    expect(counting.mostOpenAtCommand()).toBe(1);
  });

  it('does not walk the tree when each caller left while the walk waited', async () => {
    const { client, counting, upload } = await busyMachine();
    const leaveFirst = new AbortController();
    const leaveSecond = new AbortController();

    const first = outcomeOf(client.readFileTree('/', 2, leaveFirst.signal));
    const second = outcomeOf(client.readFileTree('/', 2, leaveSecond.signal));
    leaveFirst.abort(new Error('The browser left'));
    leaveSecond.abort(new Error('The browser left'));

    expect(((await first) as Error).message).toBe('The browser left');
    expect(((await second) as Error).message).toBe('The browser left');
    // A new request for the same tree starts a new walk. It does not join the walk that stopped.
    const again = client.readFileTree('/', 2);
    counting.releaseStor();
    await upload;
    expect(namesOf((await again).nodes)).toEqual(['PROGRAMS', 'SUBS', 'O1000']);
    // The upload and the new walk only
    expect(counting.logins()).toBe(2);
  });
});
