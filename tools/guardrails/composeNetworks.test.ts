import { describe, expect, it } from 'vitest';
import { networksOf } from './composeNetworks';

describe('networksOf', () => {
  it('gives "default" when the service names no network', () => {
    expect(networksOf({})).toEqual(['default']);
  });

  it('gives "default" for "networks:" with no value, which YAML reads as null', () => {
    expect(networksOf({ networks: null })).toEqual(['default']);
  });

  it('reads the short form', () => {
    expect(networksOf({ networks: ['default', 'history'] })).toEqual(['default', 'history']);
  });

  it('reads the long form, also with no settings for a network', () => {
    expect(networksOf({ networks: { history: null, default: { aliases: ['chatter'] } } })).toEqual(['history', 'default']);
  });

  it('gives no network for an empty list', () => {
    expect(networksOf({ networks: [] })).toEqual([]);
  });

  it.each(['host', 'bridge', 'service:chatterbox', 'container:chatterbox'])(
    'gives a name that is not a compose network for network_mode %s, so that it is never internal',
    mode => {
      expect(networksOf({ network_mode: mode })).toEqual([`network_mode:${mode}`]);
    },
  );

  it('reads network_mode also when the service has a networks list', () => {
    // Compose refuses this combination. The guardrail must not trust the list.
    expect(networksOf({ networks: ['history'], network_mode: 'host' })).toEqual(['history', 'network_mode:host']);
  });
});
