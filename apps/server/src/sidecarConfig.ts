export interface SidecarFlags {
  /** When true, skip MetricsWriter and AlertRuleService/vmalert startup; zero VictoriaMetrics/vmalert overhead. */
  disableHistory: boolean;
  /** When true, do not start ReleaseWatcher (zero outbound GitHub requests on air-gapped OT LANs). */
  disableUpdateCheck: boolean;
  /** When true, do not mount webAppRoutes('/') even if Dockerfile sets WEB_DIR — headless API gateway only. */
  disableWebUi: boolean;
}

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
