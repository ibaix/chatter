import { type AlertSeverity, channelWantsAlert, firstMatchingPattern, type NotificationChannel } from '@local-chatter/shared';
import type { Alert } from '../alerts/AlertStore.js';
import { createLogger } from '../logging/logger.js';
import type { AlertChange, AlertChangeListener } from './AlertChangeFinder.js';
import { severityOf, type TextOptions } from './messageText.js';
import type { Outbox } from './Outbox.js';
import type { OutgoingMessage } from './channels/ChannelType.js';
import { alertOutgoingMessage } from './outgoingMessages.js';

const log = createLogger('notifications');

const START_IGNORED = 'Ignored, because the start of this alert was ignored';

/** The reason in the message list */
function ignoredBy(pattern: string): string {
  return `Ignored by the pattern "${pattern}"`;
}

export interface NotifierOptions {
  channels: { list(): NotificationChannel[] };
  outbox: Pick<Outbox, 'queue' | 'keepIgnored' | 'combineWithWaitingStart' | 'startStatus'>;
  /** null when the machine is not there any more */
  machineName: (machineId: string) => string | null;
  textOptions: () => TextOptions;
  now?: () => number;
}

/**
 * Queues the messages of each alert change, one for each channel that wants the alert.
 * When an alert ends while its start message still waits, the channel gets one combined message.
 * A channel that did not get the start message gets no end message, so nobody reads "OK" for an alert they never saw.
 *
 * A message whose text matches an ignore pattern of the channel stays in the list as "ignored", and the channel does not get it.
 * When the start of an alert was ignored, its end is ignored too.
 */
export class AlertNotifier implements AlertChangeListener {
  constructor(private readonly options: NotifierOptions) {}

  /**
   * An error is only logged. Else the change fails again at each look, and no later alert gets its messages.
   * The messages of this change are then lost, and the log tells why.
   */
  alertChanged(change: AlertChange): void {
    try {
      this.queueMessages(change);
    } catch (error) {
      log.error('Could not queue the messages of an alert', { alert: change.alert.name, kind: change.kind, error });
    }
  }

  private queueMessages({ kind, alertId, alert }: AlertChange): void {
    const { outbox, textOptions, now = Date.now } = this.options;
    const machineName = alert.machineId === undefined ? null : this.options.machineName(alert.machineId);
    const message = (messageKind: 'started' | 'ended' | 'combined') =>
      alertOutgoingMessage({ kind: messageKind, alert, machineName }, textOptions());
    for (const channel of this.channelsThatWant(alert)) {
      const queueOrIgnore = (outgoing: OutgoingMessage) => {
        const item = { channelId: channel.id, alertId, message: outgoing };
        const pattern = firstMatchingPattern(channel.ignorePatterns, outgoing.text);
        if (pattern === null) outbox.queue(item, now());
        else outbox.keepIgnored(item, ignoredBy(pattern), now());
      };
      if (kind === 'started') {
        queueOrIgnore(message('started'));
        continue;
      }
      const startStatus = outbox.startStatus(channel.id, alertId);
      if (startStatus === null) continue;
      if (startStatus === 'ignored') {
        outbox.keepIgnored({ channelId: channel.id, alertId, message: message('ended') }, START_IGNORED, now());
        continue;
      }
      if (startStatus === 'waiting') {
        const combined = message('combined');
        const pattern = firstMatchingPattern(channel.ignorePatterns, combined.text);
        if (outbox.combineWithWaitingStart(channel.id, alertId, combined, pattern === null ? undefined : ignoredBy(pattern))) continue;
      }
      // The start went, failed, went in a "more" message, or is being sent now
      queueOrIgnore(message('ended'));
    }
  }

  private channelsThatWant(alert: Alert): NotificationChannel[] {
    return this.options.channels.list().filter(channel => channel.enabled && wantsAlert(channel, alert));
  }
}

/**
 * A rule of Chatter always has a level. An alert from another rule gets the lowest level, so it is not lost.
 * An alert that is not about one machine goes only to the channels for all machines.
 */
function wantsAlert(channel: NotificationChannel, alert: Alert): boolean {
  if (alert.machineId === undefined) return channel.machineIds === null;
  const severity: AlertSeverity = severityOf(alert) ?? 'warning';
  return channelWantsAlert(channel, { machineId: alert.machineId, severity });
}
