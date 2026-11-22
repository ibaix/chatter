import { describe, it, expect } from 'vitest';
import { readTargetNames } from './schemas.js';

const CONTROL_CHARACTER_ERROR = 'A path or a file name on the machine cannot have a line break or another control character';
const BAD_TARGET_NAMES = 'targetNames must give a name on the machine for each file name';

describe('readTargetNames', () => {
  it('gives no names when the form has no targetNames', () => {
    expect(readTargetNames(undefined)).toEqual({ ok: true, names: {} });
  });

  it('gives the name on the machine for each file name', () => {
    expect(readTargetNames('{"a.nc":"O1000","b.nc":"O2000"}'))
      .toEqual({ ok: true, names: { 'a.nc': 'O1000', 'b.nc': 'O2000' } });
  });

  // It can be called on text that no form check saw, so it gives the error and does not throw
  it.each([
    ['text that is not JSON', '{a.nc', 'targetNames must be JSON text'],
    ['empty text', '', 'targetNames must be JSON text'],
    ['a list', '["O1"]', BAD_TARGET_NAMES],
    ['a name that is not text', '{"a.nc":5}', BAD_TARGET_NAMES],
    ['a name with a line break', JSON.stringify({ 'a.nc': 'O1\r\nDELE O1234' }), CONTROL_CHARACTER_ERROR],
    ['a file name with a line break', JSON.stringify({ 'a.nc\r\nDELE O1234': 'O1' }), CONTROL_CHARACTER_ERROR],
  ])('gives an error, and does not throw, for %s', (_case, json, error) => {
    expect(readTargetNames(json)).toEqual({ ok: false, error });
  });
});
