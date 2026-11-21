import {
  type ChannelTestResult, type MessageStatus, NOTIFICATION_MESSAGE_DAYS, type NotificationKind, type NotificationMessage,
} from '@local-chatter/shared';
import type Database from 'better-sqlite3';
import type { MachineRemovalListener } from '../polling/poller.js';
import type { OutgoingMessage } from './channels/ChannelType.js';

/** A channel gets at most this many messages in SEND_LIMIT_WINDOW_MS */
export const SEND_LIMIT = 10;
export const SEND_LIMIT_WINDOW_MS = 10 * 60_000;
/** The message list keeps at most this many sent, failed, grouped and ignored messages */
export const MAX_KEPT_MESSAGES = 1000;

const KEEP_MS = NOTIFICATION_MESSAGE_DAYS * 24 * 60 * 60_000;

/** A message to queue. `alertId` is null for a message that is not about one alert. */
export interface QueuedMessage {
  channelId: string;
  alertId: number | null;
  message: OutgoingMessage;
  /**
   * True for the message of an event alert, such as "program ended". It does not count in the limit, it never goes
   * into a "more" message, and it goes also when the channel is at its limit. So the alarms keep the whole limit.
   */
  event?: boolean;
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
  status: MessageStatus;
  /** 1 for the message of an event alert */
  is_event: number;
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
    `);
    // A table of an older Chatter has no event column
    const columns = db.pragma('table_info(notification_messages)') as { name: string }[];
    if (!columns.some(column => column.name === 'is_event')) {
      db.exec('ALTER TABLE notification_messages ADD COLUMN is_event INTEGER NOT NULL DEFAULT 0');
    }
    // Chatter stopped while it sent these messages. It does not know if they went, so it sends them again.
    db.exec("UPDATE notification_messages SET sending = 0 WHERE sending = 1");
  }

  /** Returns the id of the message */
  queue(item: QueuedMessage, now: number): number {
    return this.insert(item, null, now);
  }

  /**
   * A message that matched an ignore pattern of the channel. It stays in the list with the reason, as a finished message:
   * the sender never takes it, it does not count in the limit, and it never goes into a "more" message.
   */
  keepIgnored(item: QueuedMessage, detail: string, now: number): void {
    const id = this.insert(item, null, now);
    this.db.prepare("UPDATE notification_messages SET status = 'ignored', detail = ? WHERE id = ?").run(detail, id);
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

  /** A test goes at once, not through the outbox. Its result goes in the message list, so the admin sees it there too. */
  keepTestResult(channelId: string, message: OutgoingMessage, result: ChannelTestResult, now: number): void {
    const id = this.insert({ channelId, alertId: null, message }, null, now);
    if (result.ok) this.markSent(id, result.detail, now);
    else this.markFailed(id, result.error);
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

  markSent(id: number, detail: string, now: number): void {
    this.db.prepare(`
      UPDATE notification_messages SET status = 'sent', detail = ?, sent_at = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
    `).run(detail, now, id);
  }

  markRetry(id: number, error: string, nextTryAt: number): void {
    this.db.prepare(`
      UPDATE notification_messages SET last_error = ?, next_try_at = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
    `).run(error, nextTryAt, id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE notification_messages SET status = 'failed', last_error = ?, attempts = attempts + 1, sending = 0 WHERE id = ?
    `).run(error, id);
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

  /**
   * The first waiting message of each channel that has no message being sent, when its time came.
   * An event message can go past the head (see headOrMoreMessage), so the check is for each message of the channel.
   */
  private dueHeads(now: number): MessageRow[] {
    return this.db.prepare(`
      SELECT * FROM notification_messages
      WHERE id IN (SELECT MIN(id) FROM notification_messages WHERE status = 'waiting' GROUP BY channel_id)
        AND next_try_at <= ?
        AND channel_id NOT IN (SELECT channel_id FROM notification_messages WHERE sending = 1)
      ORDER BY id
    `).all(now) as MessageRow[];
  }

  /**
   * The head message, or nothing when the channel is at its limit. When the channel has room for only one more
   * message and more alert messages wait, they all become "grouped", and a new "more" message goes in their place.
   * An event message goes at once, and at the limit the first event message that waits goes past the held messages.
   */
  private headOrMoreMessage(head: MessageRow, now: number): OutboxEntry | null {
    if (head.is_event) return toEntry(head);
    const room = SEND_LIMIT - this.sentInWindow(head.channel_id, now);
    if (room <= 0) return this.firstDueEvent(head.channel_id, now);
    const groupable = this.groupable(head.channel_id);
    if (room === 1 && groupable.messages > 1) return this.groupWaiting(head.channel_id, groupable, now);
    return toEntry(head);
  }

  private firstDueEvent(channelId: string, now: number): OutboxEntry | null {
    const row = this.db.prepare(`
      SELECT * FROM notification_messages
      WHERE channel_id = ? AND status = 'waiting' AND is_event = 1 AND sending = 0 AND next_try_at <= ?
      ORDER BY id LIMIT 1
    `).get(channelId, now) as MessageRow | undefined;
    return row ? toEntry(row) : null;
  }

  /** The event messages do not count */
  private sentInWindow(channelId: string, now: number): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM notification_messages WHERE channel_id = ? AND status = 'sent' AND is_event = 0 AND sent_at > ?
    `).get(channelId, now - SEND_LIMIT_WINDOW_MS) as { count: number }).count;
  }

  /**
   * The waiting messages that can go into a "more" message: all but the test messages and the event messages.
   * `alerts` counts the start and the end of one alert one time, and adds the alerts of a "more" message that waits.
   */
  private groupable(channelId: string): GroupableCount {
    return this.db.prepare(`
      SELECT COUNT(*) AS messages,
        COUNT(DISTINCT alert_id) + COALESCE(SUM(alert_count), 0) AS alerts
      FROM notification_messages WHERE channel_id = ? AND status = 'waiting' AND kind != 'test' AND is_event = 0
    `).get(channelId) as GroupableCount;
  }

  private groupWaiting(channelId: string, { messages, alerts }: GroupableCount, now: number): OutboxEntry {
    const others = messages - 1;
    const detail = `Grouped with ${others} more ${others === 1 ? 'message' : 'messages'}, because a channel gets at most ${SEND_LIMIT} messages in 10 minutes.`;
    this.db.prepare(`
      UPDATE notification_messages SET status = 'grouped', detail = ?
      WHERE channel_id = ? AND status = 'waiting' AND kind != 'test' AND is_event = 0
    `).run(detail, channelId);
    const message = this.moreAlerts(alerts);
    const id = this.insert({ channelId, alertId: null, message }, alerts, now);
    return { id, channelId, message, attempts: 0, createdAt: now };
  }

  /** `alertCount` is the number of alerts in a "more" message, and null for each other message */
  private insert({ channelId, alertId, message, event }: QueuedMessage, alertCount: number | null, now: number): number {
    return Number(this.db.prepare(`
      INSERT INTO notification_messages (
        channel_id, alert_id, kind, machine_id, payload, alert_count, is_event, status, next_try_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `).run(
      channelId, alertId, message.kind, message.machine?.id ?? null, JSON.stringify(message), alertCount, event ? 1 : 0, now, now,
    ).lastInsertRowid);
  }
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
