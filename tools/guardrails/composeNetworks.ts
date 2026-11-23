// Reads the "networks:" entries of a Docker Compose service.

/** The short form (a list of names) or the long form (a map of names to settings) */
export type ComposeServiceNetworks = string[] | Record<string, unknown>;

/** The networks of one service. A service with no "networks:" is only on the network "default". */
export function networksOf(networks: ComposeServiceNetworks | undefined): string[] {
  if (networks === undefined) return ['default'];
  return Array.isArray(networks) ? networks : Object.keys(networks);
}
