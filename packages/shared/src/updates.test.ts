import { describe, expect, it } from 'vitest';
import { parseUpdateStatus } from './updates.js';

const BUSY = { state: 'installing', heartbeat: '2026-11-10T12:00:00Z', freeBytes: 1000 };
const parse = (fields: Record<string, unknown>) => parseUpdateStatus(JSON.stringify({ ...BUSY, ...fields }));

describe('parseUpdateStatus with a step', () => {
  it('keeps a known step, the image number, and the start time', () => {
    expect(parse({ step: 'loading', part: 2, parts: 3, startedAt: '2026-11-10T11:55:00Z' })).toEqual({
      ...BUSY, step: 'loading', part: 2, parts: 3, startedAt: '2026-11-10T11:55:00Z',
    });
  });

  it('reads a status of an old helper, which has no step', () => {
    expect(parse({})).toEqual(BUSY);
  });

  it.each([
    ['an unknown step', 'unpacking'],
    ['a step with other text', 'loading<script>'],
    ['a step that is not text', 3],
  ])('drops %s, but keeps the status', (_name, step) => {
    const status = parse({ step, part: 1, parts: 3 });

    expect(status).toEqual(BUSY);
  });

  it.each([
    ['a part larger than the parts', 4, 3],
    ['a part of 0', 0, 3],
    ['a part that is not a whole number', 1.5, 3],
    ['a part as text', '1', 3],
    ['parts with no part', undefined, 3],
    ['too many parts', 1, 1000],
  ])('drops the image number for %s', (_name, part, parts) => {
    const status = parse({ step: 'loading', part, parts });

    expect(status).toEqual({ ...BUSY, step: 'loading' });
  });

  it('drops a start time that is not a time', () => {
    expect(parse({ step: 'files', startedAt: 'soon' })).toEqual({ ...BUSY, step: 'files' });
  });
});
