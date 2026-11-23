import { isIP } from 'node:net';

/** One IPv6 network gets a /64, and a computer in it can pick any of its 2^64 addresses */
const IPV6_NETWORK_GROUPS = 4;
const IPV6_GROUPS = 8;
const GROUP_SUFFIX = '/64';
const IPV4_TAIL = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

/** "192.0.2.33" at the end of an IPv6 address is the last two groups */
function ipv4TailAsGroups(part: string): string[] {
  const bytes = IPV4_TAIL.exec(part)!.slice(1).map(Number);
  return [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]].map(group => group.toString(16));
}

/** All 8 groups of an IPv6 address, from the short form with "::" */
function ipv6Groups(address: string): string[] {
  const split = (text: string) => (text === '' ? [] : text.split(':').flatMap(part =>
    part.includes('.') ? ipv4TailAsGroups(part) : [part]));
  const [head, tail] = address.split('::');
  const first = split(head);
  const last = tail === undefined ? [] : split(tail);
  const zeros = Array<string>(IPV6_GROUPS - first.length - last.length).fill('0');
  return [...first, ...zeros, ...last];
}

/** The first 6 groups of an IPv4-mapped IPv6 address, "::ffff:" */
const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff];

/** "192.0.2.1" for "::ffff:192.0.2.1" or "::ffff:c000:201", or null for an address that is not IPv4-mapped */
function mappedIpv4(groups: number[]): string | null {
  if (!IPV4_MAPPED_PREFIX.every((value, index) => groups[index] === value)) return null;
  const [high, low] = groups.slice(IPV4_MAPPED_PREFIX.length);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * The group of addresses that counts as one computer for the login limits.
 * An IPv4 address is its own group. An IPv4-mapped IPv6 address (like "::ffff:192.0.2.1") gives its IPv4 address.
 * Any other IPv6 address gives its /64, like "2001:db8:1:2::/64", because one computer can use many addresses in its /64.
 * A group gives the same group again. Text that is not an address stays as it is.
 */
export function addressGroup(address: string): string {
  const plain = address.endsWith(GROUP_SUFFIX) ? address.slice(0, -GROUP_SUFFIX.length) : address;
  // A link-local address can end with the name of the network card, like "%eth0"
  const withoutZone = plain.split('%')[0];
  if (isIP(withoutZone) !== 6) return address;
  const groups = ipv6Groups(withoutZone.toLowerCase()).map(group => parseInt(group, 16));
  const ipv4 = mappedIpv4(groups);
  if (ipv4 !== null) return ipv4;
  const network = groups.slice(0, IPV6_NETWORK_GROUPS).map(group => group.toString(16));
  return `${network.join(':')}::${GROUP_SUFFIX}`;
}
