/** The times of one thing over its last samples, in milliseconds */
export interface TimingStats {
  lastMs: number;
  avgMs: number;
  maxMs: number;
  /** How many samples the average and the maximum use. The server keeps a fixed number of samples. */
  samples: number;
}

/**
 * How long the polls of a machine take, so a person can see a slow machine before it goes offline.
 * Only connectors that measure their polls send it (Brother now).
 */
export interface PollTimings {
  /** The time limit of one poll. A poll that takes longer fails, and Chatter disconnects. */
  limitMs: number;
  /** The whole poll, from its start (with the connect) to its end */
  poll: TimingStats;
  /** Each command of the machine, by command name */
  commands: Record<string, TimingStats>;
  /** The last poll that ended */
  lastPoll: {
    at: string;
    totalMs: number;
    /** The time of each command that this poll sent */
    commands: Record<string, number>;
    /** The optional commands that this poll did not send, because too little time was left */
    skipped: string[];
  };
  /** The times that Chatter closed the connection on purpose and opened it again, to renew the session on the control */
  plannedReconnects: { count: number; lastAt: string | null };
}

/** The slowest commands of the last poll, the slowest first */
export function slowestCommands(timings: PollTimings, count: number): { command: string; ms: number }[] {
  return Object.entries(timings.lastPoll.commands)
    .map(([command, ms]) => ({ command, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count);
}
