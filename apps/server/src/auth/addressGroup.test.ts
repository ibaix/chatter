import { describe, expect, it } from 'vitest';
import { addressGroup } from './addressGroup.js';

describe('addressGroup', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(addressGroup('192.168.1.66')).toBe('192.168.1.66');
  });

  it('gives the same /64 for two IPv6 addresses in one network', () => {
    expect(addressGroup('2001:db8:1:2::66')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  });

  it('gives a different /64 for an address in the next network', () => {
    expect(addressGroup('2001:db8:1:3::66')).not.toBe(addressGroup('2001:db8:1:2::66'));
  });

  it('reads the short forms of IPv6', () => {
    expect(addressGroup('::1')).toBe('0:0:0:0::/64');
    expect(addressGroup('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressGroup('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  it('gives the same group again for a group, so an admin can unlock the address that the list shows', () => {
    expect(addressGroup('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');
  });

  it('keeps a text that is not an address as it is', () => {
    expect(addressGroup('unknown')).toBe('unknown');
  });
});
