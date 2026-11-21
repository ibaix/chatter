import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textLines } from './relabel.js';
import { AVERAGE_SERIES, RAW_SERIES, VictoriaHistory } from './victoriaHistory.js';

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

  beforeAll(async () => {
    server = createServer(async (request: IncomingMessage, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(part as Buffer);
      requests.push({ method: request.method!, url: request.url!, body: Buffer.concat(parts).toString() });
      response.statusCode = status;
      response.end(status === 200 ? '{"metric":{"__name__":"chatter_running"},"values":[1],"timestamps":[5]}\n' : 'bad request');
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

  it('tells the answer of VictoriaMetrics when it refuses', async () => {
    status = 400;
    try {
      await expect(new VictoriaHistory(url).importLines('x')).rejects.toThrow('VictoriaMetrics answered 400: bad request');
      await expect(new VictoriaHistory(url).exportSeries('m1', RAW_SERIES, { from: null, to: 1 }, new AbortController().signal))
        .rejects.toThrow('answered 400');
    } finally {
      status = 200;
    }
  });
});

/**
 * With a real VictoriaMetrics v1.155.0, started as in docker-compose.yml:
 *   docker run --rm -p 127.0.0.1:18429:8428 victoriametrics/victoria-metrics:v1.155.0 -dedup.minScrapeInterval=1ms
 *   CHATTER_TEST_VICTORIA_URL=http://127.0.0.1:18429 npm run test:run -w apps/server -- victoriaHistory
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
});
