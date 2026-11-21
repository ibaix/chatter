import { isBusy, type UpdateStatus } from '@local-chatter/shared';
import { Dialog } from '@toolpath/ui';
import type { ReactNode } from 'react';
import { installUpdate, type UpdatesReport } from '../../api/updates';
import { Button } from '../../components/ui/Button';
import { CommandLine } from '../../components/ui/CommandLine';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { Panel } from '../../components/ui/Panel';
import { formatSize } from '../../utils/formatters';
import {
  lastSignText,
  RESTART_HELP_AFTER_MINUTES,
  startedText,
  stepText,
  useUpdateProgress,
  wholeMinutes,
  type BusyProgress,
} from './updateProgress';

const INSTALL_WARNING = 'Chatter stops for some minutes. Machine data is not saved during that time. File transfers stop.';

/** What a change in Settings > Updates needs: run it, whether one runs now, and why the last one failed */
export interface UpdateChanges {
  /** Runs a change that gives the new report. Returns true when it worked. */
  change: (action: () => Promise<UpdatesReport>) => Promise<boolean>;
  isChanging: boolean;
  error: string | null;
}

/** The helper works now, or a request waits for it */
export function isHelperWorking(report: UpdatesReport): boolean {
  return report.isRequestPending || (report.status !== null && isBusy(report.status.state));
}

interface StatusNotice {
  tone: NoticeTone;
  title: string;
  details?: ReactNode;
}

/** How long a step can take. A Pi reads the update file from its card slowly. */
const DURATION_TEXT = {
  checking: 'On a Pi, a check can take up to about 10 minutes.',
  installing: 'On a Pi, an install can take up to about 10 minutes.',
} as const;

/** A check or an install runs: what the helper does, since when, and its last sign of life */
function BusyDetails({ status, progress }: { status: UpdateStatus; progress: BusyProgress }) {
  const step = stepText(status);
  const lines = [
    status.state === 'installing' ? 'Chatter stops for some minutes. This page comes back by itself.' : null,
    step,
    startedText(progress.elapsedMs),
    DURATION_TEXT[status.state as keyof typeof DURATION_TEXT],
    lastSignText(progress.silentMs),
  ];
  return (
    <span className="flex flex-col gap-0.5">
      {lines.filter(line => line !== null).map(line => <span key={line}>{line}</span>)}
    </span>
  );
}

/** Chatter is stopped while the new version installs, so the page cannot ask for the status */
function restartNotice(progress: BusyProgress): StatusNotice {
  if (!progress.needsHelp) {
    return {
      tone: 'info',
      title: `Chatter restarts… ${wholeMinutes(progress.elapsedMs)} min`,
      details: 'Chatter is stopped while the new version installs. This page asks again each few seconds, and shows the result.',
    };
  }
  return {
    tone: 'error',
    title: `Chatter did not come back in ${RESTART_HELP_AFTER_MINUTES} minutes`,
    details: (
      <span className="flex flex-col gap-1">
        <span>Make sure that the Pi has power and a network connection. This page continues to ask.</span>
        <span>
          When Chatter is back, the Update helper log on this page shows what the helper did. With an older card image,
          connect to the Pi with SSH and run this command:
        </span>
        <CommandLine command="journalctl -u chatter-update" />
      </span>
    ),
  };
}

const versionName = (version?: string) => (version ? `version ${version}` : 'the new version');
const startWithCapital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the page says about the last check or install */
function statusNotice(status: UpdateStatus): StatusNotice {
  const version = versionName(status.version);
  const freed = status.freedBytes ? `The update gave back ${formatSize(status.freedBytes)} of space.` : undefined;
  switch (status.state) {
    case 'checking': return { tone: 'info', title: 'Checking the update file…' };
    case 'ready': return { tone: 'success', title: `${startWithCapital(version)} passed the check` };
    case 'installing': return { tone: 'info', title: `Installing ${version}…`, details: 'Chatter stops for some minutes. This page comes back by itself.' };
    case 'done': return { tone: 'success', title: `${startWithCapital(version)} is installed`, details: freed };
    case 'refused': return { tone: 'error', title: 'The update file did not pass the check', details: status.reason };
    case 'failed': return { tone: 'error', title: 'The update failed. The old version runs, and nothing changed.', details: status.reason };
    case 'rolled-back': return { tone: 'error', title: 'The new version did not start, so the old version and its data came back', details: status.reason };
  }
}

/** A file passed the check, but a new update file came in after it. The helper installs only a checked file. */
const hasNewFileAfterCheck = ({ status, hasUpdateFile }: UpdatesReport) => status?.state === 'ready' && hasUpdateFile;

/** A waiting request comes first: the status is still the one from before the request */
function currentNotice(report: UpdatesReport, progress: BusyProgress | null): StatusNotice | null {
  if (report.isRequestPending) return { tone: 'info', title: 'Waiting for the update helper…' };
  if (hasNewFileAfterCheck(report)) {
    return { tone: 'info', title: 'A new update file needs a check', details: 'Check the new file before you install it.' };
  }
  if (progress?.isRestarting) return restartNotice(progress);
  if (!report.status) return null;
  const notice = statusNotice(report.status);
  return progress ? { ...notice, details: <BusyDetails status={report.status} progress={progress} /> } : notice;
}

interface UpdateStatusPanelProps {
  report: UpdatesReport;
  changes: UpdateChanges;
  /** The last request for the report failed, for example while Chatter restarts */
  isUnreachable: boolean;
}

/** The last check or install, and Install when a file passed the check */
export function UpdateStatusPanel({ report, changes, isUnreachable }: UpdateStatusPanelProps) {
  const progress = useUpdateProgress(report, isUnreachable);
  const notice = currentNotice(report, progress);
  if (!notice) return null;
  const { status } = report;
  const canInstall = !report.isRequestPending && status?.state === 'ready' && !report.hasUpdateFile;

  return (
    <Panel title="Update status">
      <div className="flex flex-col gap-3 px-5 py-4">
        <Notice tone={notice.tone} title={notice.title}>{notice.details}</Notice>
        {canInstall && <InstallButton version={status.version} changes={changes} />}
      </div>
    </Panel>
  );
}

function InstallButton({ version, changes }: { version?: string; changes: UpdateChanges }) {
  const { confirm } = Dialog.useDialog();
  const name = versionName(version);

  const install = async () => {
    const accepted = await confirm(
      <Dialog variant="danger">
        <Dialog.Title>Install {name}?</Dialog.Title>
        <Dialog.Message>{INSTALL_WARNING}</Dialog.Message>
        <Dialog.Actions>
          <Dialog.Dismiss>Not now</Dialog.Dismiss>
          <Dialog.Confirm>Install</Dialog.Confirm>
        </Dialog.Actions>
      </Dialog>,
    );
    if (accepted) await changes.change(installUpdate);
  };

  return (
    <div className="flex justify-end">
      <Button variant="primary" onClick={install} disabled={changes.isChanging}>Install {name}</Button>
    </div>
  );
}
