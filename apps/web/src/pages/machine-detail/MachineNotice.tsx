import { useState, type ReactNode } from 'react';
import { DocsLink } from '../../components/ui/DocsLink';
import { Notice } from '../../components/ui/Notice';
import { alarmOf, offlineReasonOf } from '../../machines/alarm';
import type { MachineState } from '../../machines/machineStatus';
import type { Machine } from '../../types';
import { formatAgo } from '../../utils/formatters';

interface MachineNoticeProps {
  machine: Machine;
  state: MachineState;
  now: number;
  /** True when the page lost its live connection to Chatter */
  chatterIsLost?: boolean;
}

interface NoticeContent {
  /** Two notices with the same key say the same thing. A closed notice stays closed until the key changes. */
  key: string;
  tone: 'alarm' | 'offline';
  title: string;
  tag?: string;
  text: ReactNode;
}

function noticeOf(machine: Machine, state: MachineState, now: number, chatterIsLost: boolean): NoticeContent | null {
  if (chatterIsLost) {
    const lastAnswer = machine.lastPollTime ? `The last values came ${formatAgo(machine.lastPollTime, now)}. ` : '';
    return {
      key: `${machine.id}:chatter-lost`,
      tone: 'offline',
      title: 'Lost the connection to Chatter',
      text: `${lastAnswer}The page tries to connect again. Check that the Chatter computer is on and on the network.`,
    };
  }
  if (state === 'offline') {
    const reason = offlineReasonOf(machine);
    const lastAnswer = machine.lastPollTime ? `The last answer came ${formatAgo(machine.lastPollTime, now)}. ` : '';
    return {
      key: `${machine.id}:offline:${reason}`,
      tone: 'offline',
      title: reason,
      text: (
        <>
          {lastAnswer}Check that the machine is on and on the network.{' '}
          <DocsLink page="guide/get-started#if-a-machine-shows-offline">What to do when a machine is offline</DocsLink>
        </>
      ),
    };
  }
  const alarm = alarmOf(machine);
  if (!alarm) return null;
  const program = machine.data.program ? ` The program was ${machine.data.program}.` : '';
  return {
    key: `${machine.id}:alarm:${alarm.code ?? ''}:${alarm.title}`,
    tone: 'alarm',
    title: alarm.title,
    tag: alarm.code ? `ALARM ${alarm.code}` : undefined,
    text: `The machine reports an alarm.${program} Clear it on the machine control.`,
  };
}

/** A box that tells about an alarm or a lost connection. The user can close it. A new problem opens it again. */
export function MachineNotice({ machine, state, now, chatterIsLost = false }: MachineNoticeProps) {
  const [closedKeys, setClosedKeys] = useState<string[]>([]);
  const notice = noticeOf(machine, state, now, chatterIsLost);
  if (!notice || closedKeys.includes(notice.key)) return null;

  return (
    <Notice
      tone={notice.tone}
      title={notice.title}
      tag={notice.tag}
      onClose={() => setClosedKeys(keys => [...keys, notice.key])}
    >
      {notice.text}
    </Notice>
  );
}
