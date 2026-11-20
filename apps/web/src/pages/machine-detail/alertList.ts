import type { MachineAlert } from '../../api/alerts';
import type { StatusTone } from '../../components/ui/StatusDot';

/** The text of an alert rule: its "summary", or else its "description" */
export function alertText(alert: MachineAlert): string {
  return alert.annotations.summary ?? alert.annotations.description ?? '';
}

/** Red for a critical alert, yellow for the other alerts */
export function alertTone(alert: MachineAlert): StatusTone {
  return alert.labels.severity === 'critical' ? 'bad' : 'check';
}

/** The alerts that fire now, and the alerts that ended. Each group stays newest first. */
export function splitFiring(alerts: MachineAlert[]): { firing: MachineAlert[]; past: MachineAlert[] } {
  return { firing: alerts.filter(alert => alert.firing), past: alerts.filter(alert => !alert.firing) };
}
