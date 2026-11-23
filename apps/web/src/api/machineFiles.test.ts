import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_LIST_CUT_SHORT_HEADER, type FTPTreeNode } from '../types';
import { fetchFileTree } from './machineFiles';

const PROGRAM: FTPTreeNode = { name: 'O1000', type: 'file', size: 10, path: '/O1000' };

function replyWith(status: number, body: unknown, headers: Record<string, string> = {}) {
  const reply = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply));
}

describe('fetchFileTree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The Files view shows two levels: the folders, and the folders in each of them
  it('gives the files, and tells that the list is complete when the server sends no cut-short header', async () => {
    replyWith(200, [PROGRAM]);

    expect(await fetchFileTree('m1', '/')).toEqual({ nodes: [PROGRAM], isCutShort: false });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/machine/m1/files?path=%2F&depth=2');
  });

  it('tells that the list is cut short when the server sends the header', async () => {
    replyWith(200, [PROGRAM], { [FILE_LIST_CUT_SHORT_HEADER]: 'true' });

    expect(await fetchFileTree('m1', '/')).toEqual({ nodes: [PROGRAM], isCutShort: true });
  });

  it('tells that the list is complete when the header is not "true"', async () => {
    replyWith(200, [PROGRAM], { [FILE_LIST_CUT_SHORT_HEADER]: 'false' });

    expect(await fetchFileTree('m1', '/')).toEqual({ nodes: [PROGRAM], isCutShort: false });
  });

  it('gives the error of the server', async () => {
    replyWith(502, { error: 'The machine did not answer' });

    await expect(fetchFileTree('m1', '/')).rejects.toThrow('The machine did not answer');
  });
});
