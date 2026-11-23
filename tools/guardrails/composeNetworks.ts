// Reads the "networks:" and "network_mode:" entries of a Docker Compose service.

/** The short form (a list of names) or the long form (a map of names to settings) */
export type ComposeServiceNetworks = string[] | Record<string, unknown>;

/** The network settings of one service */
export interface ComposeServiceNetworkSettings {
  /** "networks:" with no value is null in YAML */
  networks?: ComposeServiceNetworks | null;
  /** host, bridge, none, service:<name> or container:<name> */
  network_mode?: string;
}

function namedNetworks({ networks, network_mode }: ComposeServiceNetworkSettings): string[] {
  if (networks != null) return Array.isArray(networks) ? networks : Object.keys(networks);
  return network_mode === undefined ? ['default'] : [];
}

/**
 * The networks of one service. A service with no "networks:" is only on the network "default".
 * A network_mode gives the name "network_mode:<mode>". No compose network has this name, so it is never internal.
 */
export function networksOf(service: ComposeServiceNetworkSettings): string[] {
  const named = namedNetworks(service);
  return service.network_mode === undefined ? named : [...named, `network_mode:${service.network_mode}`];
}
