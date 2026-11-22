import {
  type ChannelTestResult, type MessageStatus, NOTIFICATION_MESSAGE_DAYS, type NotificationKind, type NotificationMessage,
} from '@local-chatter/shared';
import type Database from 'better-sqlite3';
import type { MachineRemovalListener } from '../polling/poller.js';
import type { OutgoingMessage } from './channels/ChannelType.js';
import { type AlertGroup, repeatedEventText, type TextOptions } from './messageText.js';
import { backlogMessage } from './outgoingMessages.js';

/** A channel gets at most this many messages in SEND_LIMIT_WINDOW_MS */
export const SEND_LIMIT = 10;
export const SEND_LIMIT_WINDOW_MS = 10 * 60_000;
/** The message list keeps at most this many sent, failed, grouped and ignored messages */
export const MAX_KEPT_MESSAGES = 1000;

/**
 * When the hold of a channel ends, the channel gets one summary message for the messages that waited, and then only
 * the newest BACKLOG_SEND of them. Three tell the current state of the shop. With the summary, that is 4 requests:
 * less than the burst limit of each service (ntfy.sh takes 60 at once, Discord 5 in 2 seconds), and less than
 * SEND_LIMIT, so a new alarm still has room. Without this, a day of messages went to the service at once when it
 * took messages again, and used its limit again. With BACKLOG_SEND + 1 messages or fewer, a summary saves no request,
 * so each message goes.
 */
export const BACKLOG_SEND = 3;
const BACKLOG_DETAIL = 'In one summary message, because the service did not take messages for a time.';

/**
 * A channel gets at most one message about an event of one rule on one machine in this time, for example "Program ended"
 * on the Haas VF-2. The events in between go in the next message, with their count. A machine with a short program
 * (one each 45 seconds) sent 1,176 messages in 21 hours. Now it is at most 96 in a day. A program that runs for
 * 15 minutes or longer still gets one message for each end.
 */
export const EVENT_REPEAT_MS = 15 * 60_000;
const EVENT_DETAIL = `In the next message about this event, because a channel gets at most one message about an event of a machine in ${EVENT_REPEAT_MS / 60_000} minutes.`;

const NO_TEXT_OPTIONS: TextOptions = { timeZone: null, linkBaseUrl: null };

const KEEP_MS = NOTIFICATION_MESSAGE_DAYS * 24 * 60 * 60_000;

/** A message to queue. `alertId` is null for a message that is not about one alert. */
export interface QueuedMessage {
  channelId: string;
  alertId: number | null;
  message: OutgoingMessage;
  /**
   * True for the message of an event alert, such as "program ended". It counts in the limit, like each other alert.
   * Also, the channel gets at most one message about the same rule and machine in EVENT_REPEAT_MS.
   */
  event?: boolean;
}

/** How to insert a message. Without values, it is a waiting message that is due now. */
interface InsertOptions {
  /** The number of alerts in a "more" message */
  alertCount?: number | null;
  /** A finished message, for example an ignored one, with its reason */
  finished?: { status: MessageStatus; detail: string };
  nextTryAt?: number;
  /** The events in an event message, and the time of the first one */
  repeats?: { count: number; since: number };
}

/** A message that the sender must send now */
export interface OutboxEntry {
  id: number;
  channelId: string;
  message: OutgoingMessage;
  /** The tries before this one */
  attempts: number;
  /** When Chatter queued the message, in milliseconds since 1970 */
  createdAt: number;
}

export interface MessageFilter {
  channelId?: string;
  /** Only messages queued at this time or later, in milliseconds since 1970 */
  since?: number;
}

/** Makes the message that goes in place of `count` messages over the limit, for example "And 7 more alerts" */
export type MoreAlertsMessage = (count: number) => OutgoingMessage;

interface GroupableCount {
  messages: number;
  alerts: number;
}

interface MessageRow {
  id: number;
  channel_id: string;
  alert_id: number | null;
  kind: NotificationKind;
  machine_id: string | null;
  payload: string;
  /** The number of alerts in a "more" message, and null for each other message */
  alert_count: number | null;
  status: MessageStatus;
  /** 1 for the message of an event alert */
  is_event: number;
  /** The events in an event message: 1, or more when later events of the same rule and machine went into it */
  repeats: number;
  /** The time of the first event in the message, when `repeats` is more than 1 */
  repeat_since: number | null;
  next_try_at: number;
  attempts: number;
  last_error: string | null;
  detail: string | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * The messages that wait to go out, and the messages of the last 30 days, in the "notification_messages" table.
 * Each channel gets its messages one at a time, in the order Chatter queued them.
 * A message that the sender takes is "being sent" (`sending` is 1) until the sender gives the result.
 */
export class Outbox implements MachineRemovalListener {
  constructor(
    private readonly db: Database.Database,
    private readonly moreAlerts: MoreAlertsMessage,
    /** The time zone and the link of the summary message */
    private readonly textOptions: () => TextOptions = () => NO_TEXT_OPTIONS,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        alert_id INTEGER,
        kind TEXT NOT NULL,
        machine_id TEXT,
        payload TEXT NOT NULL,
        alert_count INTEGER,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_try_at INTEGER NOT NULL,
        sending INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS notification_messages_channel ON notification_messages (channel_id, status);
      CREATE TABLE IF NOT EXISTS notification_channel_holds (
        channel_id TEXT PRIMARY KEY,
        until INTEGER NOT NULL
      );
    `);
    // A table of an older Chatter has no event column
    const columns = db.pragma('table_info(notification_messages)') as { name: string }[];
    if (!columns.some(column => column.name === 'is_event')) {
      db.exec('ALTER TABLE notification_messages ADD COLUMN is_event INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(column => column.name === 'repeats')) {
      db.exec('ALTER TABLE notification_messages ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1');
      db.exec('ALTER TABLE notification_messages ADD COLUMN repeat_since INTEGER');
    }
    // Chatter stopped while it sent these messages. It does not know if they went, so it sends them again.
    db.exec("UPDATE notification_messages SET sending = 0 WHERE sending = 1");
    // An older Chatter held a channel only with the next try of its first message. The hold keeps that order now.
    db.exec(`
      INSERT OR IGNORE INTO notification_channel_holds (channel_id, until)
      SELECT channel_id, MAX(next_try_at) FROM notification_messages WHERE status = 'waiting' AND attempts > 0 GROUP BY channel_id
    `);
  }

  /** Returns the id of the message */
  queue(item: QueuedMessage, now: number): number {
    if (!item.event) return this.insert(item, now);
    return this.db.transaction(() => this.queueEvent(item, now))();
  }

  /**
   * When a message about the same event of the machine waits, it becomes "grouped", and the new message counts its events.
   * When one went less than EVENT_REPEAT_MS ago, the new message waits until that time ends.
   * The other messages of the channel do not wait behind it (see dueHeads).
   */
  private queueEvent(item: QueuedMessage, now: number): number {
    const sameEvent = {
      channelId: item.channelId, alertName: item.message.alertName, machineId: item.message.machine?.id ?? null, now,
    };
    const sameEventWhere = `
      channel_id = @channelId AND is_event = 1 AND machine_id IS @machineId AND json_extract(payload, '$.alertName') IS @alertName
    `;
    const waiting = this.db.prepare(`
      SELECT * FROM notification_messages WHERE ${sameEventWhere} AND status = 'waiting' AND sending = 0 ORDER BY id DESC LIMIT 1
    `).get(sameEvent) as MessageRow | undefined;
    if (waiting) {
      this.db.prepare("UPDATE notification_messages SET status = 'grouped', detail = ? WHERE id = ?").run(EVENT_DETAIL, waiting.id);
      const repeats = { count: waiting.repeats + 1, since: waiting.repeat_since ?? waiting.created_at };
      const { message } = item;
      const text = repeatedEventText(message.text, message.link, repeats.count, repeats.since, this.textOptions());
      return this.insert({ ...item, message: { ...message, text } }, now, { repeats, nextTryAt: waiting.next_try_at });
    }
    // A message that is being sent now counts as sent now
    const { lastSent } = this.db.prepare(`
      SELECT MAX(CASE WHEN status = 'sent' THEN sent_at ELSE @now END) AS lastSent FROM notification_messages
      WHERE ${sameEventWhere} AND (status = 'sent' OR (status = 'waiting' AND sending = 1))
    `).get(sameEvent) as { lastSent: number | null };
    return this.insert(item, now, { nextTryAt: lastSent === null ? now : Math.max(now, lastSent + EVENT_REPEAT_MS) });
  }

  /**
   * A message that matched an ignore pattern of the channel. It stays in the list with the reason, as a finished message:
   * the sender never takes it, it does not count in the limit, and it never goes into a "more" message.
   */
  keepIgnored(item: QueuedMessage, detail: string, now: number): void {
    this.insert(item, now, { finished: { status: 'ignored', detail } });
  }

  /**
   * When the start message of the alert still waits, it becomes `combined`, so the channel gets one message.
   * With `ignoredDetail`, the combined message is ignored, with that reason, and the channel gets no message.
   * Returns false when the start message went, or is being sent. Then queue the end message.
   */
  combineWithWaitingStart(channelId: string, alertId: number, combined: OutgoingMessage, ignoredDetail?: string): boolean {
    return this.db.prepare(`
      UPDATE notification_messages SET kind = @kind, payload = @payload,
        status = CASE WHEN @ignoredDetail IS NULL THEN status ELSE 'ignored' END,
        detail = COALESCE(@ignoredDetail, detail)
      WHERE channel_id = @channelId AND alert_id = @alertId AND kind = 'started' AND status = 'waiting' AND sending = 0
    `).run({
      kind: combined.kind, payload: JSON.stringify(combined), ignoredDetail: ignoredDetail ?? null, channelId, alertId,
    }).changes > 0;
  }

  /**
   * The status of the start message of the alert on the channel, or null when the channel did not get it.
   * A channel without it gets no end message, for example a channel that the admin added while the alert was on.
   * The clean-up keeps the start message of an alert that is still on, but only for 30 days.
   * So an alert that is on for longer gets no end message.
   */
  startStatus(channelId: string, alertId: number): MessageStatus | null {
    const row = this.db.prepare(`
      SELECT status FROM notification_messages WHERE channel_id = ? AND alert_id = ? AND kind = 'started' ORDER BY id DESC LIMIT 1
    `).get(channelId, alertId) as { status: MessageStatus } | undefined;
    return row?.status ?? null;
  }

  /**
   * A test goes at once, not through the outbox. Its result goes in the message list, so the admin sees it there too.
   * A test that went shows that the channel works again, so the hold of the channel ends (see endHold).
   */
  keepTestResult(channelId: string, message: OutgoingMessage, result: ChannelTestResult, now: number): void {
    this.db.transaction(() => {
      const id = this.insert({ channelId, alertId: null, message }, now);
      if (!result.ok) return this.markFailed(id, result.error);
      this.saveSent(id, result.detail, now);
      this.endHold(channelId, now);
    })();
  }

  /**
   * The hold of the channel ends now, for example after a test that went, or after the admin saved the channel.
   * The hold row stays, so the messages that waited during the hold still go as one summary and the newest
   * BACKLOG_SEND (see summaryAfterHold). The row goes when the next queued message goes (see markSent).
   * A message that failed waits for its next try. It becomes due now, so no other message goes past it.
   * An event message that waits for EVENT_REPEAT_MS did not fail, so it continues to wait.
   */
  endHold(channelId: string, now: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE notification_channel_holds SET until = MIN(until, ?) WHERE channel_id = ?').run(now, channelId);
      this.db.prepare(`
        UPDATE notification_messages SET next_try_at = MIN(next_try_at, ?) WHERE channel_id = ? AND status = 'waiting' AND attempts > 0
      `).run(now, channelId);
    })();
  }

  /** The first waiting message of each channel, when its time came and the channel is not at its limit */
  takeDue(now: number): OutboxEntry[] {
    return this.db.transaction(() => {
      const entries: OutboxEntry[] = [];
      for (const head of this.dueHeads(now)) {
        const entry = this.headOrMoreMessage(head, now);
        if (entry) entries.push(entry);
      }
      const markSending = this.db.prepare('UPDATE notification_messages SET sending = 1 WHERE id = ?');
      for (const entry of entries) markSending.run(entry.id);
      return entries;
    })();
  }

  // Each result ends one try. Nothing changes when the message was deleted while it was being sent.

  /** The channel works again, so its hold ends, and the summary of the hold is not due any more */
  markSent(id: number, detail: string, now: number): void {
    this.db.transaction(() => {
      this.saveSent(id, detail, now);
      this.db.prepare(`
        DELETE FROM notification_channel_holds WHERE channel_id = (SELECT channel_id FROM notification_messages WHERE id = ?)
      `).run(id);
    })();
  }

  /** The message waits until `nextTryAt`, and the whole channel too, so no other message goes to a service that refused one */
  markRetry(id: number, error: string, nextTryAt: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE notification_messages SET last_error = ?, next_try_at = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
      `).run(error, nextTryAt, id);
      this.holdChannelOf(id, nextTryAt);
    })();
  }

  /**
   * With `holdUntil`, the channel gets no message until then. For example, the service asked for a wait
   * that ends after the 24 hours of this message, so the message fails, but the next message must wait too.
   */
  markFailed(id: number, error: string, holdUntil?: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE notification_messages SET status = 'failed', last_error = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
      `).run(error, id);
      if (holdUntil !== undefined) this.holdChannelOf(id, holdUntil);
    })();
  }

  /**
   * Deletes the finished messages that are older than 30 days, and then the oldest over MAX_KEPT_MESSAGES.
   * The second step keeps the start message of an alert that is still on (no end message on the channel yet),
   * because AlertNotifier needs it to send the end. An event alert has no end, so its start is not kept.
   */
  cleanUp(now: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM notification_messages WHERE status != 'waiting' AND created_at < ?").run(now - KEEP_MS);
      this.db.prepare(`
        DELETE FROM notification_messages AS message WHERE id IN (
          SELECT id FROM notification_messages WHERE status != 'waiting' ORDER BY id DESC LIMIT -1 OFFSET ?
        ) AND NOT (
          message.kind = 'started' AND message.alert_id IS NOT NULL AND message.is_event = 0 AND NOT EXISTS (
            SELECT 1 FROM notification_messages AS ended
            WHERE ended.channel_id = message.channel_id AND ended.alert_id = message.alert_id AND ended.kind = 'ended'
          )
        )
      `).run(MAX_KEPT_MESSAGES);
    })();
  }

  /** The finished messages stay in the list */
  removeChannel(channelId: string): void {
    this.db.prepare("DELETE FROM notification_messages WHERE channel_id = ? AND status = 'waiting'").run(channelId);
    this.db.prepare('DELETE FROM notification_channel_holds WHERE channel_id = ?').run(channelId);
  }

  removeMachine(machineId: string): void {
    this.db.prepare("DELETE FROM notification_messages WHERE machine_id = ? AND status = 'waiting'").run(machineId);
  }

  /** The newest first */
  list({ channelId, since }: MessageFilter): NotificationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM notification_messages
      WHERE (@channelId IS NULL OR channel_id = @channelId) AND (@since IS NULL OR created_at >= @since)
      ORDER BY id DESC
    `).all({ channelId: channelId ?? null, since: since ?? null }) as MessageRow[];
    return rows.map(toNotificationMessage);
  }

  private saveSent(id: number, detail: string, now: number): void {
    this.db.prepare(`
      UPDATE notification_messages SET status = 'sent', detail = ?, sent_at = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
    `).run(detail, now, id);
  }

  /** A new hold never makes a longer hold of the channel shorter */
  private holdChannelOf(messageId: number, until: number): void {
    this.db.prepare(`
      INSERT INTO notification_channel_holds (channel_id, until)
      SELECT channel_id, ? FROM notification_messages WHERE id = ?
      ON CONFLICT (channel_id) DO UPDATE SET until = MAX(until, excluded.until)
    `).run(until, messageId);
  }

  /**
   * The first due waiting message of each channel that has no message being sent and is not held.
   * A message that is not due yet is an event message that waits for EVENT_REPEAT_MS, so the next messages go past it.
   * A message that failed holds its whole channel (see markRetry), so no message goes past it.
   */
  private dueHeads(now: number): MessageRow[] {
    return this.db.prepare(`
      SELECT * FROM notification_messages
      WHERE id IN (SELECT MIN(id) FROM notification_messages WHERE status = 'waiting' AND next_try_at <= @now GROUP BY channel_id)
        AND channel_id NOT IN (SELECT channel_id FROM notification_messages WHERE sending = 1)
        AND channel_id NOT IN (SELECT channel_id FROM notification_channel_holds WHERE until > @now)
      ORDER BY id
    `).all({ now }) as MessageRow[];
  }

  /**
   * The head message, or nothing when the channel is at its limit. When the channel has room for only one more
   * message and more alert messages wait, they all become "grouped", and a new "more" message goes in their place.
   */
  private headOrMoreMessage(head: MessageRow, now: number): OutboxEntry | null {
    const summary = this.summaryAfterHold(head.channel_id, now);
    if (summary) return summary;
    const room = SEND_LIMIT - this.sentInWindow(head.channel_id, now);
    if (room <= 0) return null;
    const groupable = this.groupable(head.channel_id);
    if (room === 1 && groupable.messages > 1) return this.groupWaiting(head.channel_id, groupable, now);
    return toEntry(head);
  }

  /**
   * The summary message, when more than BACKLOG_SEND + 1 messages waited while the channel was held.
   * All but the newest BACKLOG_SEND of them become "grouped", so the list still shows each one. A test message is not in it.
   * dueHeads gives only a channel whose hold ended. The hold row stays until a queued message goes, so a summary waits for it too.
   * Only a message that Chatter queued before the end of the hold waited. A row can stay after the hold ended, for example
   * when the message of the hold failed for good. So the messages that came later get no summary.
   */
  private summaryAfterHold(channelId: string, now: number): OutboxEntry | null {
    const hold = this.db.prepare('SELECT until FROM notification_channel_holds WHERE channel_id = ?').get(channelId) as
      { until: number } | undefined;
    if (!hold) return null;
    const waiting = this.db.prepare(`
      SELECT * FROM notification_messages
      WHERE channel_id = ? AND status = 'waiting' AND sending = 0 AND kind != 'test' AND created_at < ?
      ORDER BY id DESC
    `).all(channelId, hold.until) as MessageRow[];
    if (waiting.length <= BACKLOG_SEND + 1) return null;
    const merged = waiting.slice(BACKLOG_SEND);
    const markGrouped = this.db.prepare("UPDATE notification_messages SET status = 'grouped', detail = ? WHERE id = ?");
    for (const row of merged) markGrouped.run(BACKLOG_DETAIL, row.id);
    const groups = alertGroups(merged);
    const message = backlogMessage(groups, this.textOptions());
    const alerts = groups.reduce((sum, group) => sum + group.count, 0);
    const id = this.insert({ channelId, alertId: null, message }, now, { alertCount: alerts });
    return { id, channelId, message, attempts: 0, createdAt: now };
  }

  /** The event messages count too, so a busy shop cannot use the limit of the service */
  private sentInWindow(channelId: string, now: number): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM notification_messages WHERE channel_id = ? AND status = 'sent' AND sent_at > ?
    `).get(channelId, now - SEND_LIMIT_WINDOW_MS) as { count: number }).count;
  }

  /**
   * The waiting messages that can go into a "more" message: all but the test messages.
   * `alerts` counts the start and the end of one alert one time, and adds the alerts of a "more" message that waits,
   * and the earlier events in an event message.
   */
  private groupable(channelId: string): GroupableCount {
    return this.db.prepare(`
      SELECT COUNT(*) AS messages,
        COUNT(DISTINCT alert_id) + COALESCE(SUM(alert_count), 0) + COALESCE(SUM(repeats - 1), 0) AS alerts
      FROM notification_messages WHERE channel_id = ? AND status = 'waiting' AND kind != 'test'
    `).get(channelId) as GroupableCount;
  }

  private groupWaiting(channelId: string, { messages, alerts }: GroupableCount, now: number): OutboxEntry {
    const others = messages - 1;
    const detail = `Grouped with ${others} more ${others === 1 ? 'message' : 'messages'}, because a channel gets at most ${SEND_LIMIT} messages in 10 minutes.`;
    this.db.prepare(`
      UPDATE notification_messages SET status = 'grouped', detail = ?
      WHERE channel_id = ? AND status = 'waiting' AND kind != 'test'
    `).run(detail, channelId);
    const message = this.moreAlerts(alerts);
    const id = this.insert({ channelId, alertId: null, message }, now, { alertCount: alerts });
    return { id, channelId, message, attempts: 0, createdAt: now };
  }

  private insert({ channelId, alertId, message, event }: QueuedMessage, now: number, options: InsertOptions = {}): number {
    return Number(this.db.prepare(`
      INSERT INTO notification_messages (
        channel_id, alert_id, kind, machine_id, payload, is_event, created_at,
        alert_count, repeats, repeat_since, status, detail, next_try_at
      )
      VALUES (
        @channelId, @alertId, @kind, @machineId, @payload, @isEvent, @now,
        @alertCount, @repeats, @repeatSince, @status, @detail, @nextTryAt
      )
    `).run({
      channelId, alertId, kind: message.kind, machineId: message.machine?.id ?? null, payload: JSON.stringify(message),
      isEvent: event ? 1 : 0, now, ...insertValues(now, options),
    }).lastInsertRowid);
  }
}

/** The values of the options of `insert`, with their defaults: a waiting message that is due now */
function insertValues(now: number, { alertCount = null, finished, nextTryAt = now, repeats }: InsertOptions) {
  return {
    alertCount, nextTryAt,
    status: finished?.status ?? 'waiting', detail: finished?.detail ?? null,
    repeats: repeats?.count ?? 1, repeatSince: repeats?.since ?? null,
  };
}

/**
 * The alerts of the messages, for each rule and machine, for example "In alarm on Haas VF-2".
 * The start and the end of one alert are one alert. An event message adds its earlier events.
 * A "more" message adds its alerts to the group with no name.
 */
function alertGroups(rows: readonly MessageRow[]): AlertGroup[] {
  const groups = new Map<string, { alerts: Set<number | string>; earlierEvents: number }>();
  let others = 0;
  for (const row of rows) {
    const message = parseMessage(row);
    if (row.kind === 'more' || !message.alertName) {
      others += row.alert_count ?? 1;
      continue;
    }
    const name = message.machine ? `${message.alertName} on ${message.machine.name}` : message.alertName;
    const group = groups.get(name) ?? { alerts: new Set(), earlierEvents: 0 };
    group.alerts.add(row.alert_id ?? `message ${row.id}`);
    group.earlierEvents += row.repeats - 1;
    groups.set(name, group);
  }
  const named: AlertGroup[] = [...groups].map(([name, group]) => ({ name, count: group.alerts.size + group.earlierEvents }));
  return others > 0 ? [...named, { name: null, count: others }] : named;
}

function toEntry(row: MessageRow): OutboxEntry {
  return { id: row.id, channelId: row.channel_id, message: parseMessage(row), attempts: row.attempts, createdAt: row.created_at };
}

function toNotificationMessage(row: MessageRow): NotificationMessage {
  const message = parseMessage(row);
  return {
    id: row.id,
    channelId: row.channel_id,
    alertId: row.alert_id,
    kind: row.kind,
    machineId: row.machine_id,
    severity: message.severity,
    text: message.text,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    detail: row.detail,
    createdAt: new Date(row.created_at).toISOString(),
    sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
  };
}

function parseMessage(row: MessageRow): OutgoingMessage {
  return JSON.parse(row.payload) as OutgoingMessage;
}
