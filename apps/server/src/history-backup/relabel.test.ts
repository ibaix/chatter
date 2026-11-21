import { describe, expect, it } from 'vitest';
import { ArchiveError } from './archive.js';
import { relabelLine, sampleFacts, textLines } from './relabel.js';

const NOW = Date.UTC(2026, 10, 21);
const target = { machineId: 'new-id', machineType: 'brother', notBefore: NOW - 1000_000, notAfter: NOW };

function exported(metric: Record<string, string>, values: unknown[], timestamps: unknown[]): string {
  return JSON.stringify({ metric, values, timestamps });
}

const goodLine = exported(
  { __name__: 'chatter_spindle_speed', machine: 'old-id', type: 'brother' }, [1200, 0, 1500.5], [NOW - 6000, NOW - 4000, NOW - 2000],
);

describe('relabelLine', () => {
  it('changes only the machine label', () => {
    const result = relabelLine(goodLine, target);
    expect(JSON.parse(result.line!)).toEqual({
      metric: { __name__: 'chatter_spindle_speed', machine: 'new-id', type: 'brother' },
      values: [1200, 0, 1500.5],
      timestamps: [NOW - 6000, NOW - 4000, NOW - 2000],
    });
    expect(result).toMatchObject({ samples: 3, tooOld: 0 });
  });

  it('takes the series of the minute and hour averages', () => {
    for (const name of ['chatter_running:avg1m', 'chatter_running:avg1h']) {
      const line = exported({ __name__: name, machine: 'old-id', type: 'brother' }, [0.5], [NOW]);
      expect(relabelLine(line, target).samples).toBe(1);
    }
  });

  it.each([
    'ALERTS', 'up', 'chatterx_running', 'chatter_', 'chatter_Running', 'chatter_running:avg5m', 'chatter_running{machine="x"}', '',
  ])('refuses the metric name %j, so a file cannot write other series', name => {
    const line = exported({ __name__: name, machine: 'old-id', type: 'brother' }, [1], [NOW]);
    expect(() => relabelLine(line, target)).toThrow(ArchiveError);
  });

  it('refuses a series of another machine type', () => {
    const line = exported({ __name__: 'chatter_running', machine: 'old-id', type: 'haas' }, [1], [NOW]);
    expect(() => relabelLine(line, target)).toThrow('another machine type');
  });

  it.each([
    ['text that is not JSON', '{"metric":'],
    ['no metric', JSON.stringify({ values: [1], timestamps: [NOW] })],
    ['a label that is not text', exported({ __name__: 'chatter_running', type: 'brother', machine: 5 as unknown as string }, [1], [NOW])],
    ['more values than times', exported({ __name__: 'chatter_running', type: 'brother' }, [1, 2], [NOW])],
    ['a value that is not a number', exported({ __name__: 'chatter_running', type: 'brother' }, ['1'], [NOW])],
    ['a time that is not a whole number', exported({ __name__: 'chatter_running', type: 'brother' }, [1], [NOW + 0.5])],
  ])('refuses %s', (_case, line) => {
    expect(() => relabelLine(line, target)).toThrow(ArchiveError);
  });

  it('refuses a time in the future', () => {
    const line = exported({ __name__: 'chatter_running', machine: 'old-id', type: 'brother' }, [1], [NOW + 60_000]);
    expect(() => relabelLine(line, target)).toThrow('in the future');
  });

  it('leaves out the samples that are older than the history keeps, and counts them', () => {
    const line = exported({ __name__: 'chatter_running', machine: 'old-id', type: 'brother' }, [1, 0], [target.notBefore - 1, NOW]);
    const result = relabelLine(line, target);
    expect(JSON.parse(result.line!)).toMatchObject({ values: [0], timestamps: [NOW] });
    expect(result).toMatchObject({ samples: 1, tooOld: 1 });

    const allOld = exported({ __name__: 'chatter_running', machine: 'old-id', type: 'brother' }, [1], [target.notBefore - 1]);
    expect(relabelLine(allOld, target)).toEqual({ line: null, samples: 0, tooOld: 1 });
  });
});

describe('sampleFacts', () => {
  it('counts the samples of an exported line, and finds its first and last time', () => {
    expect(sampleFacts(goodLine)).toEqual({ samples: 3, first: NOW - 6000, last: NOW - 2000 });
  });
});

describe('textLines', () => {
  async function* pieces(...texts: string[]) {
    for (const text of texts) yield Buffer.from(text, 'utf8');
  }
  async function linesOf(source: AsyncIterable<Uint8Array>, maxLineBytes = 100): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of textLines(source, maxLineBytes)) lines.push(line);
    return lines;
  }

  it('gives each line, also when a line is split between pieces, and skips empty lines', async () => {
    expect(await linesOf(pieces('one\ntw', 'o\n\nthr', 'ee'))).toEqual(['one', 'two', 'three']);
  });

  it('keeps a character of more than one byte that is split between pieces', async () => {
    const bytes = Buffer.from('größe\n', 'utf8');
    async function* split() {
      yield bytes.subarray(0, 3);
      yield bytes.subarray(3);
    }
    expect(await linesOf(split())).toEqual(['größe']);
  });

  it('refuses a line that is longer than the limit, before it reads the rest', async () => {
    await expect(linesOf(pieces('short\n', 'x'.repeat(60), 'x'.repeat(60)), 100)).rejects.toThrow('longer than 100 bytes');
  });
});
