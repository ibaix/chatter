import { describe, expect, it } from 'vitest';
import { slowestCommands, type PollTimings } from './pollTimings.js';

function timingsWith(commands: Record<string, number>): PollTimings {
  return {
    limitMs: 10000,
    poll: { lastMs: 0, avgMs: 0, maxMs: 0, samples: 1 },
    commands: {},
    lastPoll: { at: '2026-01-01T00:00:00.000Z', totalMs: 0, commands, skipped: [] },
    plannedReconnects: { count: 0, lastAt: null },
  };
}

describe('slowestCommands', () => {
  it('gives the slowest commands of the last poll first', () => {
    const timings = timingsWith({ PANEL: 300, MEM: 1200, ALARM: 50, PDSP: 900 });

    expect(slowestCommands(timings, 2)).toEqual([{ command: 'MEM', ms: 1200 }, { command: 'PDSP', ms: 900 }]);
  });

  it('gives all the commands when the poll sent fewer than the count', () => {
    expect(slowestCommands(timingsWith({ PANEL: 10 }), 3)).toEqual([{ command: 'PANEL', ms: 10 }]);
  });

  it('gives nothing when the poll sent no command', () => {
    expect(slowestCommands(timingsWith({}), 3)).toEqual([]);
  });
});
