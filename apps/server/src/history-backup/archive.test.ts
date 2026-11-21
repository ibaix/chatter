import { describe, expect, it } from 'vitest';
import { ArchiveError, FORMAT_VERSION, parseManifest, parsePeriodLine, type Manifest } from './archive.js';

const SHA = 'a'.repeat(64);

function manifest(changes: Record<string, unknown> = {}): Manifest {
  return {
    format: 'chatter-machine-history',
    formatVersion: FORMAT_VERSION,
    chatterVersion: '1.4.0',
    createdAt: '2026-11-21T10:00:00.000Z',
    machine: { id: 'm1', name: 'Speedio', type: 'brother' },
    range: { from: null, to: 1_795_000_000_000 },
    averagesOnly: false,
    data: { first: 1_790_000_000_000, last: 1_795_000_000_000 },
    parts: {
      'history/raw.jsonl.gz': { bytes: 10, sha256: SHA, count: 5 },
      'state-periods.jsonl.gz': { bytes: 10, sha256: SHA, count: 2 },
    },
    ...changes,
  } as Manifest;
}

describe('parseManifest', () => {
  it('reads a good manifest', () => {
    expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest());
  });

  it('refuses text that is not JSON, or a file of another kind', () => {
    expect(() => parseManifest('{')).toThrow(ArchiveError);
    expect(() => parseManifest(JSON.stringify(manifest({ format: 'something-else' })))).toThrow('not a history backup of Chatter');
  });

  it('refuses a newer format, and tells the user to update Chatter', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ formatVersion: FORMAT_VERSION + 1 })))).toThrow('newer Chatter');
  });

  it.each([0, 1.5, '1'])('refuses the format version %j', formatVersion => {
    expect(() => parseManifest(JSON.stringify(manifest({ formatVersion })))).toThrow(ArchiveError);
  });

  it('refuses a part name that it does not know', () => {
    const parts = { ...manifest().parts, '../../chatter.db': { bytes: 1, sha256: SHA, count: 0 } };
    expect(() => parseManifest(JSON.stringify(manifest({ parts })))).toThrow(ArchiveError);
  });

  it('refuses a part with a wrong hash', () => {
    const parts = { 'state-periods.jsonl.gz': { bytes: 1, sha256: 'xyz', count: 0 } };
    expect(() => parseManifest(JSON.stringify(manifest({ parts })))).toThrow(ArchiveError);
  });
});

describe('parsePeriodLine', () => {
  it('reads a period', () => {
    expect(parsePeriodLine('{"kind":"program","value":"O1000","start":5,"end":9}')).toEqual({ kind: 'program', value: 'O1000', start: 5, end: 9 });
  });

  it.each([
    '{"kind":"other","value":"x","start":5,"end":9}',
    '{"kind":"program","value":"x","start":9,"end":5}',
    '{"kind":"program","value":"x","start":5}',
    '{"kind":"program","value":"x","start":5,"end":9,"machine_id":"other"}',
    'not json',
  ])('refuses %s', line => {
    expect(() => parsePeriodLine(line)).toThrow(ArchiveError);
  });
});
