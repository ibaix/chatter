import { describe, expect, it } from 'vitest';
import { networksOf } from './composeNetworks';

describe('networksOf', () => {
  it('gives "default" when the service names no network', () => {
    expect(networksOf(undefined)).toEqual(['default']);
  });

  it('reads the short form', () => {
    expect(networksOf(['default', 'history'])).toEqual(['default', 'history']);
  });

  it('reads the long form, also with no settings for a network', () => {
    expect(networksOf({ history: null, default: { aliases: ['chatter'] } })).toEqual(['history', 'default']);
  });

  it('gives no network for an empty list', () => {
    expect(networksOf([])).toEqual([]);
  });
});
