import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlertRuleService } from '../alert-rules/AlertRuleService.js';
import { StatePeriodStore } from '../recording/StatePeriodStore.js';
import { HistoryBackup } from './HistoryBackup.js';
import { textLines } from './relabel.js';
import { AVERAGE_SERIES, HistoryUnavailableError, RAW_SERIES, VictoriaHistory } from './victoriaHistory.js';

async function textOf(source: AsyncIterable<Uint8Array>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of textLines(source, 1024 * 1024)) lines.push(line);
  return lines;
}

describe('VictoriaHistory', () => {
  let server: Server;
  let url: string;
  const requests: { method: string; url: string; body: string }[] = [];
  let status = 200;
  let seriesFound: unknown[] = [];

  beforeAll(async () => {
    server = createServer(async (request: IncomingMessage, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(part as Buffer);
      requests.push({ method: request.method!, url: request.url!, body: Buffer.concat(parts).toString() });
      response.statusCode = status;
      if (status !== 200) response.end('bad request');
      else if (request.url!.startsWith('/api/v1/series')) response.end(JSON.stringify({ status: 'success', data: seriesFound }));
      else response.end('{"metric":{"__name__":"chatter_running"},"values":[1],"timestamps":[5]}\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('exports the series of one machine whose name matches, with at most 10000 samples on a line', async () => {
    requests.length = 0;
    const lines = await textOf(await new VictoriaHistory(url).exportSeries('m"1', RAW_SERIES, { from: 1000, to: 5500 }, new AbortController().signal));

    expect(lines).toEqual(['{"metric":{"__name__":"chatter_running"},"values":[1],"timestamps":[5]}']);
    const asked = new URL(requests[0].url, url);
    expect(asked.pathname).toBe('/api/v1/export');
    expect(asked.searchParams.get('match[]')).toBe('{__name__=~"chatter_[a-z0-9_]+",machine="m\\"1"}');
    expect(asked.searchParams.get('start')).toBe('1.000');
    expect(asked.searchParams.get('end')).toBe('5.500');
    expect(asked.searchParams.get('max_rows_per_line')).toBe('10000');
    // Block by block, so VictoriaMetrics does not hold a whole series in memory
    expect(asked.searchParams.get('reduce_mem_usage')).toBe('1');
  });

  it('leaves out the start for all the history', async () => {
    requests.length = 0;
    await textOf(await new VictoriaHistory(url).exportSeries('m1', AVERAGE_SERIES, { from: null, to: 5000 }, new AbortController().signal));
    expect(new URL(requests[0].url, url).searchParams.has('start')).toBe(false);
  });

  it('imports lines, and then resets the kept query answers', async () => {
    requests.length = 0;
    const history = new VictoriaHistory(url);
    await history.importLines('{"a":1}\n');
    await history.importDone();
    expect(requests.map(({ method, url: path, body }) => `${method} ${path} ${body}`)).toEqual([
      'POST /api/v1/import {"a":1}\n',
      'GET /internal/resetRollupResultCache ',
    ]);
  });

  it('finds if a machine has a Chatter series with samples in a time', async () => {
    requests.length = 0;
    const history = new VictoriaHistory(url);
    seriesFound = [];
    expect(await history.hasSamples('m"1', 1000, 5500)).toBe(false);
    seriesFound = [{ __name__: 'chatter_running', machine: 'm"1' }];
    expect(await history.hasSamples('m"1', 1000, 5500)).toBe(true);
    const asked = new URL(requests[0].url, url);
    expect(asked.pathname).toBe('/api/v1/series');
    expect(asked.searchParams.get('match[]')).toBe('{__name__=~"chatter_[a-z0-9_]+(:avg1[mh])?",machine="m\\"1"}');
    expect(asked.searchParams.get('start')).toBe('1.000');
    expect(asked.searchParams.get('end')).toBe('5.500');
    expect(asked.searchParams.get('limit')).toBe('1');
  });

  it('tells the answer of VictoriaMetrics when it refuses', async () => {
    status = 400;
    try {
      await expect(new VictoriaHistory(url).importLines('x')).rejects.toThrow('VictoriaMetrics answered 400: bad request');
      await expect(new VictoriaHistory(url).importLines('x')).rejects.toBeInstanceOf(HistoryUnavailableError);
      await expect(new VictoriaHistory(url).exportSeries('m1', RAW_SERIES, { from: null, to: 1 }, new AbortController().signal))
        .rejects.toThrow('answered 400');
      await expect(new VictoriaHistory(url).importDone()).rejects.toBeInstanceOf(HistoryUnavailableError);
    } finally {
      status = 200;
    }
  });

  it('tells that VictoriaMetrics does not answer when nothing listens', async () => {
    const closed = new VictoriaHistory('http://127.0.0.1:1');
    await expect(closed.importLines('x')).rejects.toBeInstanceOf(HistoryUnavailableError);
    await expect(closed.exportSeries('m1', RAW_SERIES, { from: null, to: 1 }, new AbortController().signal)).rejects.toBeInstanceOf(HistoryUnavailableError);
  });
});

/**
 * With a real VictoriaMetrics and vmalert v1.155.0, as in docker-compose.yml (the CI runs these too):
 *   tools/victoria-test/start.sh
 *   CHATTER_TEST_VICTORIA_URL=http://127.0.0.1:18429 npm run test:run -w apps/server -- victoriaHistory
 *   tools/victoria-test/stop.sh
 */
const REAL_URL = process.env.CHATTER_TEST_VICTORIA_URL;

describe.skipIf(!REAL_URL)('VictoriaHistory with a real VictoriaMetrics', () => {
  const machine = `it-${Date.now()}`;
  const copy = `${machine}-copy`;

  async function query(text: string): Promise<string | undefined> {
    const response = await fetch(`${REAL_URL}/api/v1/query?${new URLSearchParams({ query: text })}`);
    const reply = await response.json() as { data: { result: { value: [number, string] }[] } };
    return reply.data.result[0]?.value[1];
  }

  it('exports a machine, imports it as another machine twice, and the copy has each sample once', async () => {
    const history = new VictoriaHistory(REAL_URL!);
    const now = Date.now();
    const lines = Array.from({ length: 300 }, (_, index) => `chatter_running{machine="${machine}",type="brother"} ${index % 2} ${now - 40 * 60_000 + index * 2000}`);
    await fetch(`${REAL_URL}/api/v1/import/prometheus`, { method: 'POST', body: lines.join('\n') });
    await fetch(`${REAL_URL}/internal/force_flush`);

    const exported = await textOf(await history.exportSeries(machine, RAW_SERIES, { from: null, to: now }, new AbortController().signal));
    expect(exported.length).toBeGreaterThan(0);
    const relabelled = exported.map(line => line.replace(`"machine":"${machine}"`, `"machine":"${copy}"`)).join('\n');
    await history.importLines(relabelled);
    await history.importLines(relabelled);
    await fetch(`${REAL_URL}/internal/force_flush`);
    await history.importDone();

    expect(await query(`count_over_time(chatter_running{machine="${copy}"}[60m])`)).toBe('300');
    expect(await query(`sum_over_time(chatter_running{machine="${copy}"}[60m])`)).toBe('150');
  });

  it('backs up and restores averages with the staleness markers of vmalert (tools/victoria-test/rules.yml)', async () => {
    const history = new VictoriaHistory(REAL_URL!);
    const stopped = `${machine}-stopped`;
    const restored = `${machine}-restored`;
    // 10 seconds of values until now. vmalert saves averages, and a staleness marker when the values stop.
    const now = Date.now();
    const lines = Array.from({ length: 10 }, (_, index) => `chatter_running{machine="${stopped}",type="brother"} ${index % 2} ${now - 9000 + index * 1000}`);
    await fetch(`${REAL_URL}/api/v1/import/prometheus`, { method: 'POST', body: lines.join('\n') });
    const exportedAverages = async () => {
      await fetch(`${REAL_URL}/internal/force_flush`);
      return (await textOf(await history.exportSeries(stopped, AVERAGE_SERIES, { from: null, to: Date.now() }, new AbortController().signal))).join('\n');
    };
    await vi.waitFor(async () => expect(await exportedAverages()).toContain('null'), { timeout: 90_000, interval: 1000 });
    const averages = (await exportedAverages()).split('\n').map(line => JSON.parse(line) as { values: (number | null)[] });
    const samples = averages.flatMap(line => line.values).filter(value => value !== null).length;
    expect(samples).toBeGreaterThan(0);

    const folder = mkdtempSync(path.join(os.tmpdir(), 'history-real-'));
    try {
      const backups = new HistoryBackup({
        folder, history, statePeriods: StatePeriodStore.inMemory(), alertRules: AlertRuleService.inMemory(), version: 'test',
      });
      const prepared = await backups.prepareBackup({ id: stopped, name: 'Stopped', type: 'brother' }, { from: null, to: Date.now(), averagesOnly: true }, 'admin');
      expect(prepared.manifest.parts['history/averages.jsonl.gz']!.count).toBe(samples);
      const archive = Buffer.from(await new Response(backups.download(prepared.id, stopped, 'admin').stream).arrayBuffer());
      await new Promise(resolve => setTimeout(resolve, 20));
      const target = { id: restored, name: 'Restored', type: 'brother' };
      const preview = await backups.receiveRestore(new Response(archive).body!, archive.length, target, 'admin');
      expect(preview.counts.averageSamples).toBe(samples);
      expect(await backups.restore(preview.id, target, { alertRules: false }, 'admin')).toMatchObject({ samples });
      await fetch(`${REAL_URL}/internal/force_flush`);
      await history.importDone();
      expect(await query(`count_over_time(chatter_running:avg1m{machine="${restored}"}[10m])`)).toBe(String(samples));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 120_000);
});
