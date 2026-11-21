import { autoHistoryWindow, historyWindowValue } from '@local-chatter/shared';
import { Hono } from 'hono';
import type { HardwarePoller } from '../polling/poller.js';
import type { HistorySource } from '../recording/MetricsReader.js';
import { historyMetricName } from '../recording/metricLines.js';
import type { StatePeriod, StatePeriodStore } from '../recording/StatePeriodStore.js';
import { readTimelinePeriods, stateTimeline, type TimelineSegment } from '../recording/stateTimeline.js';
import { checkedParam, checkedQuery } from './checks.js';
import { durationMs } from './duration.js';
import { historyUnavailable, notFound } from './responses.js';
import { historyParams, historyQuery, periodQuery, timelineQuery } from './schemas.js';

const DEFAULT_PERIOD_RANGE = '-1d';
const DEFAULT_HISTORY_RANGE = '-1h';
/** One reply has at most this many points, so a big range cannot make a huge reply */
const MAX_POINTS = 5000;
/** One reply has at most this many state periods. `more` tells that older ones were left out. */
const MAX_PERIODS = 1000;

const DEFAULT_TIMELINE_RANGE = '-24h';
/**
 * The state timeline reads at most this many periods. A machine that changes state every 30 seconds for 7 days
 * has fewer. With more, the timeline starts at the oldest period it read, and `more` is true (readTimelinePeriods).
 */
const MAX_TIMELINE_PERIODS = 50_000;

/** Windows start at whole multiples of the window, so the points stay the same when the chart reloads */
function alignedWindowStart(time: number, windowMs: number): number {
  return Math.floor(time / windowMs) * windowMs;
}

function periodReply(period: StatePeriod) {
  return {
    kind: period.kind,
    value: period.value,
    start: new Date(period.start).toISOString(),
    end: period.end === undefined ? null : new Date(period.end).toISOString(),
  };
}

function segmentReply({ state, start, end, detail, program }: TimelineSegment) {
  return {
    state,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    ...(detail === undefined ? {} : { detail }),
    ...(program === undefined ? {} : { program }),
  };
}

/** The end of the asked time: `end`, or now. An end in the future is now, because no data is there. */
function endOf(end: string | undefined): number {
  const now = Date.now();
  return end === undefined ? now : Math.min(Date.parse(end), now);
}

/** Machine values over time: numbers from VictoriaMetrics, and state periods from SQLite */
export function historyRoutes(poller: HardwarePoller, history: HistorySource, periods: StatePeriodStore) {
  return new Hono()
    .get('/machine/:id/periods', checkedQuery(periodQuery), c => {
      const machineId = c.req.param('id');
      if (!poller.getMachine(machineId)) return notFound(c);

      const { range = DEFAULT_PERIOD_RANGE, kind } = c.req.valid('query');
      const to = Date.now();
      const found = periods.read({ machineId, from: to - durationMs(range), to, kind, limit: MAX_PERIODS + 1 });
      return c.json({
        machineId,
        range,
        data: found.slice(0, MAX_PERIODS).map(periodReply),
        more: found.length > MAX_PERIODS,
      });
    })
    .get('/machine/:id/state-timeline', checkedQuery(timelineQuery), c => {
      const machineId = c.req.param('id');
      if (!poller.getMachine(machineId)) return notFound(c);

      const { range = DEFAULT_TIMELINE_RANGE, end } = c.req.valid('query');
      const to = endOf(end);
      const read = readTimelinePeriods(periods, { machineId, from: to - durationMs(range), to, limit: MAX_TIMELINE_PERIODS });
      return c.json({
        machineId,
        range,
        from: new Date(read.from).toISOString(),
        to: new Date(to).toISOString(),
        data: stateTimeline(read.periods, read.from, to).map(segmentReply),
        more: read.more,
      });
    })
    .get('/machine/:id/history/:value', checkedParam(historyParams), checkedQuery(historyQuery), async c => {
      const { id: machineId, value } = c.req.valid('param');
      if (!poller.getMachine(machineId)) return notFound(c);

      const query = c.req.valid('query');
      const range = query.range ?? DEFAULT_HISTORY_RANGE;
      const rangeMs = durationMs(range);
      const window = query.window ?? autoHistoryWindow(rangeMs);
      const windowMs = durationMs(window);
      // The first window starts before the range (at a whole multiple of the window), so a reply can have one more point
      if (rangeMs / windowMs + 1 > MAX_POINTS) {
        const problem = query.window ? 'The window is too small for this range' : 'The range is too long';
        return c.json({ error: `${problem}. One reply can have at most ${MAX_POINTS} points.` }, 400);
      }

      const to = endOf(query.end);
      const from = alignedWindowStart(to - rangeMs, windowMs);
      let points;
      try {
        points = await history.windowAverages({
          metric: historyMetricName(value), machineId, from, to, windowMs, windowValue: historyWindowValue(value),
        });
      } catch (error) {
        return historyUnavailable(c, '[History]', error);
      }
      const data = points.map(point => ({ time: new Date(point.time).toISOString(), value: point.value }));
      return c.json({ machineId, value, range, window, data });
    });
}
