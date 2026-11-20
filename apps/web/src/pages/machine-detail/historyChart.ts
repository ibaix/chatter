import type { HistoryPoint } from '../../api/history';

export type HistoryStatus = 'loading' | 'ready' | 'failed';

/** The charts move on this often, also when no new value comes */
export const CHART_CLOCK_TICK_MS = 5000;

/**
 * A chart waits this long after a move in time before it loads, so a quick series of moves (a scroll or a swipe)
 * sends one request, not one for each step.
 */
export const MOVE_LOAD_DELAY_MS = 200;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/** "5m" or "-1h" in milliseconds */
export function durationMs(text: string): number {
  const match = /^-?(\d+)([smhdw])$/.exec(text);
  if (!match) throw new Error(`Not a duration: ${text}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

export interface ChartRange {
  /** A range button, or 'zoom' for a time that the user highlighted on the overview strip */
  id: '10m' | '1h' | '24h' | '7d' | 'zoom';
  /** The words after "in the last" */
  words: string;
  ms: number;
  /** The range the server wants, such as "-1h" */
  query: string;
  /** The time each average covers. Without one, the server picks it, at most 1000 points. */
  window?: string;
}

/** The time ranges the chart offers. The server keeps every value 30 days, and minute averages 1 year. */
export const CHART_RANGES: ChartRange[] = [
  { id: '10m', words: '10 minutes', ms: 10 * MINUTE, query: '-10m', window: '5s' },
  { id: '1h', words: 'hour', ms: HOUR, query: '-1h' },
  { id: '24h', words: '24 hours', ms: DAY, query: '-24h' },
  { id: '7d', words: '7 days', ms: 7 * DAY, query: '-7d' },
];

/** Points that are further apart than this have no data between them, so the line has a gap there */
export const GAP_MS = 15_000;

/** The gap for averages of `windowMs`: three missing averages in a row */
export function gapFor(windowMs: number): number {
  return Math.max(GAP_MS, 3 * windowMs);
}

/**
 * Add the newest live value, when it is newer than the last point.
 * The chart keeps one point for each window of `windowMs`, so a page that stays open does not collect
 * more points than the chart can show. A value in the same window as the last point takes its place.
 * A `windowMs` of 0 keeps every value.
 * The windows are fixed, so the last point cannot slide forward with each value and leave a gap behind it.
 */
export function withLivePoint(points: HistoryPoint[], live: HistoryPoint, windowMs = 0): HistoryPoint[] {
  const last = points[points.length - 1];
  if (!last) return [live];
  if (live.time <= last.time) return points;
  if (windowMs > 0 && windowOf(live.time, windowMs) === windowOf(last.time, windowMs)) {
    return [...points.slice(0, -1), live];
  }
  return [...points, live];
}

function windowOf(time: number, windowMs: number): number {
  return Math.floor(time / windowMs);
}

/** The loaded history, then the live values that came after it (they can arrive while it loads) */
export function mergeHistory(history: HistoryPoint[], live: HistoryPoint[]): HistoryPoint[] {
  const historyEnd = history[history.length - 1]?.time ?? -Infinity;
  return [...history, ...live.filter(point => point.time > historyEnd)];
}

/** The points from `from` on. The points after the end of a chart in the past stay, because a drag can show them. */
export function pointsFrom(points: HistoryPoint[], from: number): HistoryPoint[] {
  return points.filter(point => point.time >= from);
}

/**
 * The parts of the line: a new part starts after each gap.
 * When the machine is connected, the last value holds until now, so the line reaches the right edge.
 */
export function lineParts(points: HistoryPoint[], now: number, connected: boolean, gapMs = GAP_MS): HistoryPoint[][] {
  const parts: HistoryPoint[][] = [];
  points.forEach((point, index) => {
    const startsNewPart = index === 0 || point.time - points[index - 1].time > gapMs;
    if (startsNewPart) parts.push([point]);
    else parts[parts.length - 1].push(point);
  });

  const last = points[points.length - 1];
  if (connected && last && now - last.time <= gapMs && now > last.time) {
    parts[parts.length - 1].push({ time: now, value: last.value });
  }
  return parts;
}

/**
 * The points of a step line: each value holds until the next point, then the line goes straight up or down.
 * For a counter or a tool number, because a slope between T3 and T4 is not a value that the machine had.
 */
export function stepPoints(points: HistoryPoint[]): HistoryPoint[] {
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    return previous && previous.value !== point.value ? [{ time: point.time, value: previous.value }, point] : [point];
  });
}

/**
 * Round numbers for the value axis, from 0 to just above the biggest value.
 * The axis goes at least to `smallestTop`. A `smallestTop` of 20 or more keeps the steps whole numbers.
 */
export function axisTicks(maxValue: number, smallestTop = 100, stepCount = 4): number[] {
  const top = Math.max(maxValue, smallestTop);
  const roughStep = top / stepCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= roughStep)!;
  const tickCount = Math.ceil(top / step);
  return Array.from({ length: tickCount + 1 }, (_, index) => index * step);
}

/** The point nearest to `time`, for the hover readout */
export function nearestPoint(points: HistoryPoint[], time: number): HistoryPoint | undefined {
  let nearest: HistoryPoint | undefined;
  for (const point of points) {
    if (!nearest || Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
  }
  return nearest;
}

/** 8000 → "8,000". Axis labels from 10,000 up are short: 12500 → "12.5K". */
export function formatChartNumber(value: number, short = false): string {
  if (short && value >= 10_000) return `${Number((value / 1000).toFixed(1))}K`;
  return Math.round(value).toLocaleString('en-US');
}

export interface TimeLabel {
  time: number;
  text: string;
}

function clockText(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayText(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

/** Five labels under the chart, from the start of the range to its end. A live chart ends with "Now". */
export function timeLabels(rangeMs: number, end: number, live = true): TimeLabel[] {
  const format = rangeMs > DAY ? dayText : clockText;
  return [4, 3, 2, 1, 0].map(quarter => {
    const time = end - (rangeMs * quarter) / 4;
    return { time, text: quarter === 0 && live ? 'Now' : format(time) };
  });
}

/**
 * The end of the chart after a move of `deltaMs`: negative goes back in time, positive goes on.
 * `end` null is the live chart, which ends now. A move that reaches now gives null, so the chart is live again.
 */
export function pannedEnd(end: number | null, deltaMs: number, now: number): number | null {
  const next = (end ?? now) + deltaMs;
  return next >= now ? null : next;
}

function dateTimeText(time: number): string {
  return new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The time that a chart shows, after its description: "in the last hour", or "from Nov 19, 2:00 PM to Nov 19, 3:00 PM" */
export function viewText(range: ChartRange, end: number | null): string {
  if (end === null) return `in the last ${range.words}`;
  return `from ${dateTimeText(end - range.ms)} to ${dateTimeText(end)}`;
}

/** The text in place of the chart while the history loads, when it fails, or when it is empty */
export function messageFor(status: HistoryStatus, valueName: string, range: ChartRange, end: number | null = null): string {
  const name = valueName.toLowerCase();
  if (status === 'loading') return `Loading the ${name} history…`;
  if (status === 'failed') return `Could not load the ${name} history. Reload the page to try again.`;
  return `No ${name} ${viewText(range, end)}. Chatter saves it while the machine is connected.`;
}

export interface TimeScale {
  /** The x position of a time */
  x: (time: number) => number;
  /** The time at an x position: the reverse of `x` */
  timeAt: (offsetX: number) => number;
}

/** The x positions of a plot that shows `rangeMs` from `startTime`, from `left` to `left + width` */
export function timeScale(startTime: number, rangeMs: number, left: number, width: number): TimeScale {
  return {
    x: time => left + ((time - startTime) / rangeMs) * width,
    timeAt: offsetX => startTime + ((offsetX - left) / width) * rangeMs,
  };
}

/** The first time label starts at the left edge and the last one ends at the right edge, so both stay inside the chart */
export function timeLabelAnchor(index: number, labelCount: number): 'start' | 'middle' | 'end' {
  if (index === 0) return 'start';
  if (index === labelCount - 1) return 'end';
  return 'middle';
}

const SECOND = 1000;
/** A zoom is at least this long, so a very small highlight still shows some time */
const MIN_ZOOM_MS = 30 * SECOND;
/** A zoomed chart asks for about this many windows, so it shows detail */
const ZOOM_POINTS = 300;

/** "40 seconds", "12 minutes", "4 hours" or "3 days", for the text under the title */
function durationWords(ms: number): string {
  if (ms < 2 * MINUTE) return `${Math.round(ms / SECOND)} seconds`;
  if (ms < 2 * HOUR) return `${Math.round(ms / MINUTE)} minutes`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / DAY)} days`;
}

/** The range of a zoom of `ms`. Its window gives about ZOOM_POINTS points, and at least 1 second. */
function zoomRange(ms: number): ChartRange {
  const seconds = Math.round(ms / SECOND);
  return {
    id: 'zoom',
    words: durationWords(ms),
    ms: seconds * SECOND,
    query: `-${seconds}s`,
    window: `${Math.max(1, Math.round(seconds / ZOOM_POINTS))}s`,
  };
}

/**
 * The chart view of a time that the user highlighted, from `from` to `to`. A very short highlight grows to
 * MIN_ZOOM_MS around its middle. A highlight that reaches now gives a live chart (end null).
 */
export function zoomView(from: number, to: number, now: number): { range: ChartRange; end: number | null } {
  const ms = Math.max(to - from, MIN_ZOOM_MS);
  const end = Math.min((from + to) / 2 + ms / 2, now);
  return { range: zoomRange(ms), end: end >= now - SECOND ? null : end };
}

/**
 * The end of the overview strip after the view changed. The overview shows `overviewMs` (the range button that
 * the user picked last), and it always holds the view. It moves only when the view goes out of it.
 * Null is an overview that ends now: it is live when the view is live, or when it gets to now.
 */
export function fittedOverviewEnd(
  overviewEnd: number | null,
  overviewMs: number,
  viewEnd: number | null,
  viewMs: number,
  now: number,
): number | null {
  if (viewEnd === null) return null;
  const end = overviewEnd ?? now;
  const next = viewEnd > end ? viewEnd : viewEnd - viewMs < end - overviewMs ? viewEnd - viewMs + overviewMs : end;
  if (next === end) return overviewEnd;
  return next >= now - SECOND ? null : next;
}

/** The server takes a range of at most 6 digits, such as "-999999s" */
const MAX_RANGE_DIGITS = 999_999;

/** A time length as a range for the server, in the biggest unit that fits: "-20m", "-21d" or "-903s" */
function rangeQuery(ms: number): string {
  for (const [unit, unitMs] of [['d', DAY], ['h', HOUR], ['m', MINUTE]] as const) {
    if (ms % unitMs === 0) return `-${ms / unitMs}${unit}`;
  }
  const seconds = Math.ceil(ms / SECOND);
  return seconds <= MAX_RANGE_DIGITS ? `-${seconds}s` : `-${Math.ceil(ms / MINUTE)}m`;
}

/**
 * The time that a chart loads: one more range before the time that it shows, and one more after it, up to now.
 * A drag then shows data at once, and the next load comes in while the old data still shows.
 * `end` null is a span that ends now.
 */
export function loadSpan(range: ChartRange, end: number | null, now: number): { query: string; end: number | null } {
  const from = (end ?? now) - 2 * range.ms;
  const to = end === null || end + range.ms >= now - SECOND ? null : end + range.ms;
  return { query: rangeQuery((to ?? now) - from), end: to };
}
