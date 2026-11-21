// Reads the "ports:" entries of a Docker Compose file.

export type ComposePort =
  | string
  | number
  | { target?: string | number; published?: string | number; host_ip?: string; protocol?: string };

export interface OpenedPorts {
  /** The host address that the ports listen on. Empty means all addresses. */
  hostIp: string;
  /** The ports in the container that the entry opens */
  containerPorts: number[];
}

function range(text: string): number[] {
  const [first, last = first] = text.split('-').map(Number);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The host address and the container ports of one "ports:" entry, in the short or the long form. */
export function portsOpened(entry: ComposePort): OpenedPorts {
  if (typeof entry === 'number') return { hostIp: '', containerPorts: [entry] };
  if (typeof entry === 'object') return { hostIp: entry.host_ip ?? '', containerPorts: range(String(entry.target ?? '')) };

  // [HOST_IP:][HOST_PORT:]CONTAINER_PORT[/PROTOCOL]. An IPv6 host address is in brackets.
  const withoutProtocol = entry.split('/')[0];
  const ipv6 = /^\[([^\]]+)\]:(.*)$/.exec(withoutProtocol);
  const parts = ipv6 ? [ipv6[1], ...ipv6[2].split(':')] : withoutProtocol.split(':');
  return {
    hostIp: parts.length === 3 ? parts[0] : '',
    containerPorts: range(parts[parts.length - 1]),
  };
}
