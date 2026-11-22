import type { ConnectionTestReport, ConnectionTestStep, MachineHealth, TestResult } from '@local-chatter/shared';
import { cn } from '@toolpath/ui';
import { useCallback, useEffect, useState } from 'react';
import { fetchMachineHealth, reconnectMachine, testMachineConnection } from '../../api/diagnostics';
import { useCan } from '../../components/CurrentUser';
import { useNow } from '../../hooks/useNow';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import type { Machine } from '../../types';
import { errorMessageOf } from '../../utils/errorMessage';
import { formatAgo, formatDateTime } from '../../utils/formatters';

const UNKNOWN_ERROR = 'Something went wrong. Try again.';

const RESULT_LABELS: Record<TestResult, string> = { ok: 'OK', failed: 'Failed', warning: 'Warning', skipped: 'Not done' };
const RESULT_STYLES: Record<TestResult, string> = {
  ok: 'bg-running/20 text-primary-text',
  failed: 'bg-alarm/30 text-alarm-soft',
  warning: 'bg-idle/25 text-zinc-50',
  skipped: 'bg-zinc-800 text-zinc-200',
};

/** The "ago" texts change each 30 seconds */
const CLOCK_TICK_MS = 30_000;

/**
 * The connection of the machine: since when it is offline, its last error, and its last connection changes.
 * A user who can manage machines can also test the connection and reconnect the machine.
 */
export function ConnectionSection({ machine }: { machine: Machine }) {
  const now = useNow(CLOCK_TICK_MS);
  const canManageMachines = useCan('manage-machines');
  const { health, clockOffset, reload } = useMachineHealth(machine.id);

  return (
    <div className="flex flex-col gap-4 p-4">
      <HealthFacts machine={machine} health={health} serverNow={now + clockOffset} />
      {canManageMachines && <ConnectionActions machineId={machine.id} onDone={reload} />}
      {health && health.events.length > 0 && <ConnectionEvents events={health.events} />}
    </div>
  );
}

/**
 * The health of the machine, and the server clock minus the browser clock, measured when the health came.
 * The poll times come from the server clock, so the "ago" texts count on the server clock.
 */
function useMachineHealth(machineId: string) {
  const [health, setHealth] = useState<MachineHealth | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const reload = useCallback(() => {
    // The health is extra help, so a failed load shows only the live status
    fetchMachineHealth(machineId).then(loaded => {
      const serverTime = Date.parse(loaded.serverTime);
      if (!Number.isNaN(serverTime)) setClockOffset(serverTime - Date.now());
      setHealth(loaded);
    }, () => {});
  }, [machineId]);
  useEffect(reload, [reload]);
  return { health, clockOffset, reload };
}

function HealthFacts({ machine, health, serverNow }: { machine: Machine; health: MachineHealth | null; serverNow: number }) {
  const facts: [string, string][] = [['Last good poll', formatAgo(machine.lastPollTime, serverNow)]];
  if (health?.offlineSince) facts.push(['Offline since', formatDateTime(health.offlineSince)]);
  if (health?.lastError) facts.push(['Last error', `${health.lastError.text} (${formatDateTime(health.lastError.time)})`]);
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-zinc-300">{label}</dt>
          <dd className="m-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConnectionActions({ machineId, onDone }: { machineId: string; onDone: () => void }) {
  const [report, setReport] = useState<ConnectionTestReport | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<'test' | 'reconnect' | null>(null);

  const run = async (kind: 'test' | 'reconnect') => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === 'test') {
        setReport(await testMachineConnection(machineId));
      } else {
        setMessage({ tone: 'success', text: await reconnectMachine(machineId) });
      }
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessageOf(error, UNKNOWN_ERROR) });
    } finally {
      setBusy(null);
      onDone();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => run('test')} disabled={busy !== null}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
        <Button onClick={() => run('reconnect')} disabled={busy !== null}>{busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}</Button>
      </div>
      <p className="m-0 text-xs text-zinc-300">
        The test connects to the saved address and ports of the machine. It does not use ping. Chatter stops the polls of
        this machine during the test, because some controls accept only one connection.
      </p>
      {message && <Notice tone={message.tone} title={message.text} />}
      {report && <TestReport report={report} />}
    </div>
  );
}

function TestReport({ report }: { report: ConnectionTestReport }) {
  return (
    <section aria-label="Connection test result" className="flex flex-col gap-2">
      <p className="m-0 text-xs text-zinc-300">Test of {report.host} at {formatDateTime(report.testedAt)}</p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {report.steps.map(step => <TestStep key={step.name} step={step} />)}
      </ol>
    </section>
  );
}

function TestStep({ step }: { step: ConnectionTestStep }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-zinc-800 px-3 py-2">
      <span className={cn('min-w-16 rounded px-1.5 py-0.5 text-center text-xs font-bold', RESULT_STYLES[step.result])}>
        {RESULT_LABELS[step.result]}
      </span>
      <span className="flex flex-col gap-0.5 text-sm">
        <span className="font-bold">{step.name}</span>
        <span>{step.text}</span>
        {step.hint && <span className="text-zinc-300">{step.hint}</span>}
      </span>
    </li>
  );
}

function ConnectionEvents({ events }: { events: MachineHealth['events'] }) {
  return (
    <section aria-label="Last connection changes" className="flex flex-col gap-1.5">
      <h3 className="m-0 text-sm font-bold">Last connection changes</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
        {events.map(event => (
          <li key={`${event.time}-${event.text}`} className="flex gap-3">
            <span className="whitespace-nowrap text-zinc-300">{formatDateTime(event.time)}</span>
            <span className={event.tone === 'bad' ? 'text-alarm-soft' : 'text-primary-text'}>{event.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
