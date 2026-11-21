import { Dialog } from '@toolpath/ui';
import type { ReactNode } from 'react';
import { fetchSystemFacts, restartChatter, restartPi, type SystemFacts } from '../../api/diagnostics';
import { Button } from '../../components/ui/Button';
import { DocsLink } from '../../components/ui/DocsLink';
import { Notice } from '../../components/ui/Notice';
import { Panel } from '../../components/ui/Panel';
import { formatDateTime } from '../../utils/formatters';
import { HelperLogPanel } from './HelperLogPanel';
import { LogPanel } from './LogPanel';
import type { MachineName } from './notificationLabels';
import { ReportPending } from './ReportPending';
import { useRestartWait, type RestartPhase } from './useRestartWait';
import { useServerReport } from './useServerReport';

/**
 * Settings > Diagnostics: the facts of this computer, the server log, the support bundle, and the restarts.
 * With these, nobody needs SSH to find a problem.
 */
export function DiagnosticsTab({ machines }: { machines: MachineName[] }) {
  const { report: facts, loadError, change, isChanging, changeError } = useServerReport(fetchSystemFacts);
  const restart = useRestartWait();
  if (loadError || !facts) return <ReportPending loadError={loadError} />;

  const ask = async (action: () => Promise<void>) => {
    const startedAt = facts.startedAt;
    if (await change(async () => {
      await action();
      return facts;
    })) restart.wait(startedAt);
  };

  return (
    <>
      <ComputerPanel facts={facts} />
      <RestartPanel facts={facts} phase={restart.phase} isBusy={isChanging} error={changeError} onRestart={ask} />
      <LogPanel machines={machines} />
      {facts.isPiCard && <HelperLogPanel />}
      <p className="m-0 text-sm text-zinc-300">
        To read more, see <DocsLink page="guide/diagnostics">Diagnostics</DocsLink> in the Chatter docs.
      </p>
    </>
  );
}

function ComputerPanel({ facts }: { facts: SystemFacts }) {
  const { network } = facts;
  const rows: [string, ReactNode][] = [
    ['Chatter version', <span className="font-mono">{facts.version}</span>],
    ['Chatter started', formatDateTime(facts.startedAt)],
    ['Address of this page', <span className="font-mono">{window.location.host}</span>],
  ];
  if (network) {
    if (network.hostname) rows.push(['Host name', <span className="font-mono">{network.hostname}</span>]);
    if (network.localName) rows.push(['Name on the network', <span className="font-mono">{network.localName}</span>]);
    for (const { interface: name, address } of network.addresses) {
      rows.push([`Address (${name})`, <span className="font-mono">{address}</span>]);
    }
    if (network.gateway) rows.push(['Gateway', <span className="font-mono">{network.gateway}</span>]);
    rows.push(['SSH', network.ssh ? 'On' : 'Off'], ['Facts written', formatDateTime(network.updatedAt)]);
  }
  return (
    <Panel title="This computer">
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 px-5 py-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-300">{label}</dt>
            <dd className="m-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {facts.isPiCard && !network && (
        <div className="px-5 pb-4">
          <Notice tone="info" title="A new card image shows more facts here">
            The update helper of this Pi does not write the network facts (the addresses, the gateway, and SSH).
            A newer card image does.
          </Notice>
        </div>
      )}
    </Panel>
  );
}

interface RestartPanelProps {
  facts: SystemFacts;
  phase: RestartPhase;
  isBusy: boolean;
  error: string | null;
  onRestart: (action: () => Promise<void>) => Promise<void>;
}

const RESTART_NOTICES: Record<Exclude<RestartPhase, 'idle'>, { tone: 'info' | 'success' | 'error'; title: string; text: string }> = {
  waiting: { tone: 'info', title: 'Chatter restarts…', text: 'This page asks each 2 seconds, and tells you when Chatter is back.' },
  back: { tone: 'success', title: 'Chatter is back', text: 'Load the page again to see the newest values.' },
  late: {
    tone: 'error',
    title: 'Chatter did not come back in 5 minutes',
    text: 'Make sure that the computer has power and a network connection. This page continues to ask.',
  },
};

/** Restart Chatter (Docker starts it again), or the Pi (the update helper does it) */
function RestartPanel({ facts, phase, isBusy, error, onRestart }: RestartPanelProps) {
  const { confirm } = Dialog.useDialog();
  const isWaiting = phase === 'waiting' || phase === 'late';

  const ask = async (title: string, message: string, action: () => Promise<void>) => {
    const accepted = await confirm(
      <Dialog variant="danger">
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Message>{message}</Dialog.Message>
        <Dialog.Actions>
          <Dialog.Dismiss>Not now</Dialog.Dismiss>
          <Dialog.Confirm>Restart</Dialog.Confirm>
        </Dialog.Actions>
      </Dialog>,
    );
    if (accepted) await onRestart(action);
  };

  const notice = phase === 'idle' ? null : RESTART_NOTICES[phase];
  return (
    <Panel title="Restart" description="Chatter writes each restart, with your user name, in the log.">
      <div className="flex flex-col gap-3 px-5 py-4">
        {!facts.canRestartChatter && (
          <p className="m-0 text-sm text-zinc-300">Chatter does not run in Docker here, so it cannot restart from this page.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {facts.canRestartChatter && (
            <Button
              variant="danger"
              disabled={isBusy || isWaiting}
              onClick={() => ask(
                'Restart Chatter?',
                'Chatter stops for about 1 minute. Machine data is not saved during that time. File transfers stop.',
                restartChatter,
              )}
            >
              Restart Chatter
            </Button>
          )}
          {facts.canRestartPi && (
            <Button
              variant="danger"
              disabled={isBusy || isWaiting}
              onClick={() => ask(
                'Restart the Pi?',
                'The Pi and Chatter stop for about 2 minutes. Machine data is not saved during that time. '
                  + 'A checked update file must be checked again after the restart.',
                restartPi,
              )}
            >
              Restart the Pi
            </Button>
          )}
        </div>
        {facts.isPiCard && !facts.canRestartPi && (
          <p className="m-0 text-xs text-zinc-300">To restart the Pi from this page, a new card image is necessary.</p>
        )}
        {error && <Notice tone="error" title={error} />}
        {notice && <Notice tone={notice.tone} title={notice.title}>{notice.text}</Notice>}
      </div>
    </Panel>
  );
}
