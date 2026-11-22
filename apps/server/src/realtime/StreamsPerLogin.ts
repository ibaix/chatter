/**
 * The open live streams of each login, the oldest first.
 * When a login has more streams than the limit, the oldest one closes.
 */
export class StreamsPerLogin {
  /** The close function of each open stream, for each login */
  private readonly streams = new Map<string, (() => void)[]>();

  constructor(private readonly maxPerLogin: number) {}

  /**
   * Adds a stream of `login`. If the login then has too many streams, this calls `close` of its oldest stream.
   * Gives the function that removes the stream when it ends.
   */
  add(login: string, close: () => void): () => void {
    const streams = this.streams.get(login) ?? [];
    this.streams.set(login, streams);
    streams.push(close);
    while (streams.length > this.maxPerLogin) streams.shift()?.();
    return () => this.remove(login, close);
  }

  private remove(login: string, close: () => void): void {
    const streams = this.streams.get(login);
    if (!streams) return;
    const index = streams.indexOf(close);
    if (index >= 0) streams.splice(index, 1);
    if (streams.length === 0) this.streams.delete(login);
  }
}
