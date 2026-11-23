import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { once } from 'events';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type net from 'net';
import { FTPClient, MAX_FOLDER_LIST_BYTES, MAX_TREE_DEPTH, MAX_TREE_ENTRIES } from './FTPClient.js';
import type { FTPTreeNode } from '../types/index.js';

// The tree limits against the FTP server of the fake machines (tools/fake-machines/ftp.ts).
// That server sends a real "ls -l" listing over a real data connection, as a machine does.
// The server is outside the source folder of this app, so it is imported by its address and not type-checked here.

type StartFtpServer = (root: string, host: string, port: number) => net.Server;
const FAKE_FTP_SERVER = new URL('../../../../tools/fake-machines/ftp.ts', import.meta.url).href;
const { startFtpServer } = (await import(FAKE_FTP_SERVER)) as { startFtpServer: StartFtpServer };

const HOST = '127.0.0.1';
/** A walk of some folders on a slow computer can take some seconds */
const WALK_TEST_TIME_MS = 30_000;
/** A long file name makes a long listing with fewer files */
const LONG_NAME_LENGTH = 200;
/** More than MAX_FOLDER_LIST_BYTES of listing, but fewer files than MAX_TREE_ENTRIES */
const LONG_NAME_FILE_COUNT = 4800;

let root: string;
let server: net.Server;
let ftpClient: FTPClient;

function levelsOf(nodes: FTPTreeNode[]): number {
  return 1 + Math.max(0, ...nodes.map(node => (node.children?.length ? levelsOf(node.children) : 0)));
}

async function writeFiles(folder: string, names: string[]): Promise<void> {
  await mkdir(folder, { recursive: true });
  await Promise.all(names.map(name => writeFile(path.join(folder, name), '')));
}

const longName = (index: number) => `${String(index).padStart(5, '0')}${'X'.repeat(LONG_NAME_LENGTH - 5)}`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'chatter-ftp-tree-'));
  // Folders 7 levels deep, with one program in each
  await writeFiles(path.join(root, 'DEEP', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'), ['O7000']);
  // More files than one tree can hold
  await writeFiles(path.join(root, 'MANY'), Array.from({ length: MAX_TREE_ENTRIES + 1 }, (_, index) => `O${index}`));
  // A listing that is longer than MAX_FOLDER_LIST_BYTES
  await writeFiles(path.join(root, 'LONG'), Array.from({ length: LONG_NAME_FILE_COUNT }, (_, index) => longName(index)));
  server = startFtpServer(root, HOST, 0);
  await once(server, 'listening');
  ftpClient = new FTPClient({ host: HOST, port: (server.address() as net.AddressInfo).port });
}, WALK_TEST_TIME_MS);

afterAll(async () => {
  server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('FTPClient tree limits against the fake machine FTP server', () => {
  it(`walks only ${MAX_TREE_DEPTH} levels of folders that are 7 levels deep`, async () => {
    const tree = await ftpClient.readFileTree('/DEEP', 50);

    expect(levelsOf(tree.nodes)).toBe(MAX_TREE_DEPTH);
    expect(tree.isCutShort).toBe(false);
  }, WALK_TEST_TIME_MS);

  it(`keeps ${MAX_TREE_ENTRIES} entries of a folder with more files, and tells that it cut the list`, async () => {
    const tree = await ftpClient.readFileTree('/MANY', 1);

    expect(tree.nodes).toHaveLength(MAX_TREE_ENTRIES);
    expect(tree.isCutShort).toBe(true);
  }, WALK_TEST_TIME_MS);

  // A rogue server can send a listing with no end. Chatter must stop at the byte limit, not when the server stops.
  it(`reads at most ${MAX_FOLDER_LIST_BYTES} bytes of one folder listing, and tells that it cut the list`, async () => {
    const tree = await ftpClient.readFileTree('/LONG', 1);

    expect(tree.isCutShort).toBe(true);
    expect(tree.nodes.length).toBeGreaterThan(0);
    expect(tree.nodes.length).toBeLessThan(LONG_NAME_FILE_COUNT);
    // Each line has the name and at least 40 more characters, so the kept lines are not longer than the limit
    expect(tree.nodes.length * (LONG_NAME_LENGTH + 40)).toBeLessThanOrEqual(MAX_FOLDER_LIST_BYTES);
    // A line that the limit cut in two is not kept
    expect(tree.nodes.every((node, index) => node.name === longName(index))).toBe(true);
  }, WALK_TEST_TIME_MS);
});
