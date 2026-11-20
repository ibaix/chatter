export interface SidecarFlags {
  /** When true, skip MetricsWriter and AlertRuleService/vmalert startup; zero VictoriaMetrics/vmalert overhead. */
  disableHistory: boolean;
  /** When true, do not start ReleaseWatcher (zero outbound GitHub requests on air-gapped OT LANs). */
  disableUpdateCheck: boolean;
  /** When true, do not mount webAppRoutes('/') even if Dockerfile sets WEB_DIR — headless API gateway only. */
  disableWebUi: boolean;
}

/** All sidecar limits off. Startup and the API stay the same as a normal Chatter. */
export const SIDECAR_OFF: SidecarFlags = {
  disableHistory: false,
  disableUpdateCheck: false,
  disableWebUi: false,
};

/** HTTP status when sidecar mode refuses an action that would call another computer. */
export const SIDECAR_OUTBOUND_STATUS = 503;

/** The reply when the update check is off and the action would call GitHub. */
export const UPDATE_OUTBOUND_ERROR = 'Chatter sends no update request. The update check is off.';

/** The reply when history is off and the action would send a notification. */
export const NOTIFICATION_OUTBOUND_ERROR = 'Chatter sends no notification. Notification sending is off.';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function parseSidecarFlags(env: NodeJS.ProcessEnv = process.env): SidecarFlags {
  const isEnabled = (value: string | undefined): boolean =>
    value !== undefined && TRUTHY.has(value.trim().toLowerCase());
  return {
    disableHistory: isEnabled(env.CHATTER_DISABLE_HISTORY),
    disableUpdateCheck: isEnabled(env.CHATTER_DISABLE_UPDATE_CHECK),
    disableWebUi: isEnabled(env.CHATTER_DISABLE_WEB_UI),
  };
}

/**
 * Start the notification sender.
 * Returns false when history is off.
 * The sender then stays stopped, so a saved queue sends no Slack, Twilio, webhook, or Apprise message.
 */
export function startOutboundNotifications(notifications: { start(): void }, flags: SidecarFlags): boolean {
  if (flags.disableHistory) return false;
  notifications.start();
  return true;
}
