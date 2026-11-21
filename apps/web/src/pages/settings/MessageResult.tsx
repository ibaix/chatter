import { cn } from '@toolpath/ui';
import type { NotificationMessage } from '../../api/notifications';
import { StatusDot } from '../../components/ui/StatusDot';
import { STATUS_LABELS, STATUS_TONES } from './notificationLabels';

/**
 * The state of a message, and under it the error of a failed message, the error of the last try of a waiting message
 * (for example a limit of the service), or the reply of the service
 */
export function MessageResult({ message }: { message: NotificationMessage }) {
  const isFailed = message.status === 'failed';
  const line = isFailed || message.status === 'waiting' ? message.lastError : message.detail;
  return (
    <div className="flex flex-col gap-0.5">
      <StatusDot tone={STATUS_TONES[message.status]}>{STATUS_LABELS[message.status]}</StatusDot>
      {line && <span className={cn('text-xs', isFailed ? 'text-alarm-soft' : 'text-zinc-300')}>{line}</span>}
    </div>
  );
}
