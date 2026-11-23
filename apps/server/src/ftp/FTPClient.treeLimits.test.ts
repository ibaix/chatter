import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import type { FTPTreeNode } from '../types/index.js';

// A rogue or very large FTP server must not make Chatter walk a folder tree with no end.
// Each folder level costs a LIST on the machine, and each entry costs memory (a Pi can have 512 MB).
// The fake machine below answers each folder with the listing that `listingOf` gives.

interface FakeEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

let currentFolder = '/';
let listingOf: (folder: string) => FakeEntry[] | Promise<FakeEntry[]> = () => [];
const listedFolders: string[] = [];
/** The lists that wait for the machine. A close of the client stops them, as basic-ftp does. */
let stopWaitingLists: Array<(err: Error) => void> = [];

/** A folder list that waits until the client closes */
function waitForever(): Promise<FakeEntry[]> {
  return new Promise((_resolve, reject) => stopWaitingLists.push(reject));
}

const mockFtpClient = {
  access: vi.fn(),
  // PASV fails, so the client uses the list of basic-ftp and no data socket opens
  send: vi.fn(async () => {
    throw new Error('500 Not supported');
  }),
  cd: vi.fn(async (folder: string) => {
    currentFolder = folder;
  }),
  pwd: vi.fn(async () => currentFolder),
  list: vi.fn(async () => {
    listedFolders.push(currentFolder);
    return listingOf(currentFolder);
  }),
  close: vi.fn(() => {
    stopWaitingLists.forEach(stop => stop(new Error('User closed client')));
    stopWaitingLists = [];
  }),
  ftp: { verbose: false, socket: { write: vi.fn() } },
};

vi.mock('basic-ftp', () => ({
  Client: vi.fn(function () { return mockFtpClient; }),
}));

// Imported after vi.mock so FTPClient gets the mock basic-ftp
import { FTPClient, FOLDER_LIST_TIME_LIMIT_MS, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, MAX_TREE_FOLDERS, TREE_WALK_TIME_LIMIT_MS } from './FTPClient.js';

const folder = (name: string): FakeEntry => ({ name, isDirectory: true, size: 0 });
const file = (name: string): FakeEntry => ({ name, isDirectory: false, size: 10 });

/** The number of folder levels in the tree: 1 when the top level has no folder with children */
function levelsOf(nodes: FTPTreeNode[]): number {
  return 1 + Math.max(0, ...nodes.map(node => (node.children?.length ? levelsOf(node.children) : 0)));
}

function countNodes(nodes: FTPTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0);
}

describe('FTPClient.getFileTree limits', () => {
  let log: CapturedLog;

  beforeEach(() => {
    vi.clearAllMocks();
    currentFolder = '/';
    listedFolders.length = 0;
    stopWaitingLists = [];
    log = captureLog();
  });

  afterEach(() => {
    vi.useRealTimers();
    log.restore();
  });

  it(`stops at ${MAX_TREE_DEPTH} levels when a caller asks for more`, async () => {
    // Each folder holds one more folder, with no end
    listingOf = () => [folder('SUB'), file('O1000')];

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 50);

    expect(listedFolders).toHaveLength(MAX_TREE_DEPTH);
    expect(levelsOf(tree)).toBe(MAX_TREE_DEPTH);
  });

  it('walks the depth that the caller asks for when it is below the cap', async () => {
    listingOf = () => [folder('SUB'), file('O1000')];

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 3);

    expect(listedFolders).toEqual(['/', '/SUB', '/SUB/SUB']);
    expect(levelsOf(tree)).toBe(3);
  });

  it(`keeps at most ${MAX_TREE_ENTRIES} entries and opens no more folders after that`, async () => {
    // 100 folders in each folder: 100 + 10 000 entries in two levels
    listingOf = () => Array.from({ length: 100 }, (_, index) => folder(`D${index}`));

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 3);

    expect(countNodes(tree)).toBe(MAX_TREE_ENTRIES);
    // The root, then the first 49 folders fill the rest: 100 + 49 * 100 = 5000
    expect(listedFolders).toHaveLength(1 + 49);
    expect(log.text('warn')).toContain(`The file tree on 192.168.1.50 is too large. Chatter shows only the first ${MAX_TREE_ENTRIES} entries.`);
  });

  // The web app shows two levels: the folders, and the folders in each of them.
  // A full deep folder must not take the entries of the folders next to it.
  it('lists each level of the tree before it opens the level below it', async () => {
    listingOf = folderPath => {
      if (folderPath === '/') return [folder('A'), folder('B')];
      if (folderPath === '/A') return [folder('A1')];
      if (folderPath === '/B') return [folder('B1')];
      return Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => file(`O${index}`));
    };

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 3);

    expect(listedFolders).toEqual(['/', '/A', '/B', '/A/A1']);
    expect(tree.nodes.find(node => node.name === 'B')?.children?.map(child => child.name)).toEqual(['B1']);
    expect(countNodes(tree.nodes)).toBe(MAX_TREE_ENTRIES);
    expect(tree.isCutShort).toBe(true);
  });

  it(`keeps at most ${MAX_TREE_ENTRIES} entries from one very long folder`, async () => {
    listingOf = () => Array.from({ length: MAX_TREE_ENTRIES + 10 }, (_, index) => file(`O${index}`));

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 1);

    expect(tree).toHaveLength(MAX_TREE_ENTRIES);
    expect(tree.at(-1)?.name).toBe(`O${MAX_TREE_ENTRIES - 1}`);
  });

  // The web app shows a note when the list is cut short, so the user knows that files are missing
  it('tells the caller when it cut the tree short', async () => {
    listingOf = () => Array.from({ length: MAX_TREE_ENTRIES + 1 }, (_, index) => file(`O${index}`));

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 1);

    expect(tree.nodes).toHaveLength(MAX_TREE_ENTRIES);
    expect(tree.isCutShort).toBe(true);
  });

  it('tells the caller when it opened no more folders because the tree was full', async () => {
    // The root fills the tree, so the walk cannot open the folders in it
    listingOf = folderPath => (folderPath === '/' ? Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => folder(`D${index}`)) : [file('O1')]);

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 2);

    expect(tree.nodes).toHaveLength(MAX_TREE_ENTRIES);
    expect(tree.isCutShort).toBe(true);
  });

  it(`does not call a tree of exactly ${MAX_TREE_ENTRIES} entries cut short`, async () => {
    listingOf = () => Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => file(`O${index}`));

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 1);

    expect(tree.nodes).toHaveLength(MAX_TREE_ENTRIES);
    expect(tree.isCutShort).toBe(false);
  });

  it('gives an empty tree that is not cut short, and does not connect, for a depth of 0', async () => {
    listingOf = () => [folder('SUB'), file('O1000')];

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 0);

    expect(tree).toEqual({ nodes: [], isCutShort: false });
    expect(listedFolders).toEqual([]);
    expect(mockFtpClient.access).not.toHaveBeenCalled();
  });

  it('does not call a tree cut short when it stops at the depth that the caller asks for', async () => {
    listingOf = () => [folder('SUB'), file('O1000')];

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 2);

    expect(levelsOf(tree.nodes)).toBe(2);
    expect(tree.isCutShort).toBe(false);
  });

  it(`writes no warning for a tree of exactly ${MAX_TREE_ENTRIES} entries`, async () => {
    listingOf = () => Array.from({ length: MAX_TREE_ENTRIES }, (_, index) => file(`O${index}`));

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 1);

    expect(tree).toHaveLength(MAX_TREE_ENTRIES);
    expect(log.text('warn')).toBe('');
  });

  it('writes no warning for a normal tree', async () => {
    listingOf = folderPath => (folderPath === '/' ? [folder('PRG'), file('O1000')] : [file('O2000')]);

    const tree = await new FTPClient({ host: '192.168.1.50' }).getFileTree('/', 3);

    expect(countNodes(tree)).toBe(3);
    expect(log.text('warn')).toBe('');
  });

  // Each folder costs some commands and a LIST on the machine, also an empty folder
  it(`opens at most ${MAX_TREE_FOLDERS} folders in one walk, and tells that it cut the tree`, async () => {
    listingOf = folderPath => (folderPath === '/' ? Array.from({ length: MAX_TREE_FOLDERS + 50 }, (_, index) => folder(`D${index}`)) : []);

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 2);

    expect(listedFolders).toHaveLength(MAX_TREE_FOLDERS);
    expect(tree.nodes).toHaveLength(MAX_TREE_FOLDERS + 50);
    expect(tree.isCutShort).toBe(true);
    expect(log.text('warn')).toContain(`The file tree on 192.168.1.50 has too many folders. Chatter opens at most ${MAX_TREE_FOLDERS} folders.`);
  });

  it(`does not call a walk of exactly ${MAX_TREE_FOLDERS} folders cut short`, async () => {
    listingOf = folderPath => (folderPath === '/' ? Array.from({ length: MAX_TREE_FOLDERS - 1 }, (_, index) => folder(`D${index}`)) : []);

    const tree = await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 2);

    expect(listedFolders).toHaveLength(MAX_TREE_FOLDERS);
    expect(tree.isCutShort).toBe(false);
  });

  // A slow machine must not keep one walk (and its FTP connection) busy for a long time
  it('stops the walk at its time limit, keeps what it read, and tells that it cut the tree', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listingOf = folderPath => {
      if (folderPath === '/') return [folder('A'), folder('SLOW'), folder('B')];
      if (folderPath === '/SLOW') return waitForever();
      return [file('O1000')];
    };

    const walk = new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 2);
    await vi.waitFor(() => expect(listedFolders).toContain('/SLOW'));
    await vi.advanceTimersByTimeAsync(TREE_WALK_TIME_LIMIT_MS);
    const tree = await walk;

    expect(listedFolders).toEqual(['/', '/A', '/SLOW']);
    expect(tree.nodes.find(node => node.name === 'A')?.children?.map(child => child.name)).toEqual(['O1000']);
    expect(tree.isCutShort).toBe(true);
    expect(log.text('warn')).toContain(`The file tree on 192.168.1.50 took too long. Chatter stops a walk after ${TREE_WALK_TIME_LIMIT_MS / 1000} s.`);
  });

  it('leaves no timer after a walk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listingOf = () => [file('O1000')];

    await new FTPClient({ host: '192.168.1.50' }).readFileTree('/', 1);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a folder list at its time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    listingOf = () => waitForever();

    const listing = new FTPClient({ host: '192.168.1.50' }).listFiles('/PRG');
    const failure = listing.catch((err: unknown) => err);
    await vi.waitFor(() => expect(listedFolders).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(FOLDER_LIST_TIME_LIMIT_MS);

    expect(String(await failure)).toContain('The folder list on the machine took too long');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Many clicks on "Load the files again" must not open one FTP connection and one walk for each click
  it('shares one walk between requests for the same tree that come at the same time', async () => {
    listingOf = () => [file('O1000')];
    const ftpClient = new FTPClient({ host: '192.168.1.50' });

    const [first, second] = await Promise.all([ftpClient.readFileTree('/', 2), ftpClient.readFileTree('/', 2)]);

    expect(mockFtpClient.access).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('walks again for a request after the walk ended, and for a different tree', async () => {
    listingOf = () => [file('O1000')];
    const ftpClient = new FTPClient({ host: '192.168.1.50' });

    await ftpClient.readFileTree('/', 2);
    await Promise.all([ftpClient.readFileTree('/', 2), ftpClient.readFileTree('/', 1), ftpClient.readFileTree('/PRG', 2)]);

    expect(mockFtpClient.access).toHaveBeenCalledTimes(4);
  });
});
