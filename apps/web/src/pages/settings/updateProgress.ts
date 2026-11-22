import { isBusy, type UpdateStatus, type UpdateStep } from '@local-chatter/shared';
import { useEffect, useMemo, useState } from 'react';
import type { UpdatesReport } from '../../api/updates';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The texts change each second while the helper works */
const TICK_MS = SECOND;

/** Chatter stops during an install. After this long with no answer, the page tells the user what to do. */
const RESTART_HELP_AFTER_MS = 20 * MINUTE;
export const RESTART_HELP_AFTER_MINUTES = RESTART_HELP_AFTER_MS / MINUTE;

/** What the helper does in each step. Only these fixed texts show: never text from status.json. */
const STEP_TEXTS: Record<UpdateStep, string> = {
  copying: 'the helper copies the update file.',
  listing: 'the helper examines the list of files in the update file.',
  signature: 'the helper examines the signature.',
  space: 'the helper measures the free space and the Chatter data.',
  files: 'the helper unpacks the files and examines their checksums.',
  images: 'the helper examines the images that are already on the Pi.',
  verifying: 'the helper examines the checksums of the checked files again.',
  'backing-up': 'the helper stops Chatter and makes a backup of the data.',
  loading: 'the helper loads the new images.',
  starting: 'the helper starts the new version.',
  health: 'the helper waits until the new version runs correctly.',
};

/** "Now: the helper loads image 2 of 3.", or null when the helper gave no step (a helper of an older card) */
export function stepText({ step, part, parts }: UpdateStatus): string | null {
  if (!step) return null;
  if (step === 'loading' && part && parts) return `Now: the helper loads image ${part} of ${parts}.`;
  return `Now: ${STEP_TEXTS[step]}`;
}

/** What the page knows about a check or an install that runs now */
export interface BusyProgress {
  /** The time since the start of the check or the install */
  elapsedMs: number;
  /** The time since the last heartbeat of the helper */
  silentMs: number;
  /** An install runs, and Chatter does not answer: it restarts */
  isRestarting: boolean;
  /** Chatter did not answer for RESTART_HELP_AFTER_MS */
  needsHelp: boolean;
}

/**
 * Counts the time of a check or an install that runs now, each second, or gives null when the helper does not work.
 * The helper writes its times with the clock of the Pi. The browser clock can be different, so all times are
 * counted on the server clock: serverTime of the report, plus the time since the report came.
 * A helper of an older card writes no start time. Then the count starts when the page first saw the busy state.
 */
export function useUpdateProgress(report: UpdatesReport, isUnreachable: boolean): BusyProgress | null {
  const { status } = report;
  const busyState = status && isBusy(status.state) ? status.state : null;
  const now = useTick(busyState !== null);
  // The server clock minus the browser clock, measured when the report came
  const clockOffset = useMemo(() => {
    const serverTime = Date.parse(report.serverTime);
    return Number.isNaN(serverTime) ? 0 : serverTime - Date.now();
  }, [report]);
  const firstSeen = useTimeWhenTrue(busyState, busyState !== null);
  const unreachableSince = useTimeWhenTrue('unreachable', isUnreachable);

  if (!status || busyState === null) return null;
  const serverNow = now + clockOffset;
  const startedAt = status.startedAt ? Date.parse(status.startedAt) : (firstSeen ?? now) + clockOffset;
  const isRestarting = busyState === 'installing' && isUnreachable;
  return {
    elapsedMs: Math.max(0, serverNow - startedAt),
    silentMs: Math.max(0, serverNow - Date.parse(status.heartbeat)),
    isRestarting,
    needsHelp: isRestarting && unreachableSince !== null && now - unreachableSince >= RESTART_HELP_AFTER_MS,
  };
}

/** "Started 3 min ago.", or "Started less than 1 min ago." */
export function startedText(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / MINUTE);
  return minutes < 1 ? 'Started less than 1 min ago.' : `Started ${minutes} min ago.`;
}

/** "Last sign of life: 5 s ago." */
export function lastSignText(silentMs: number): string {
  return `Last sign of life: ${Math.floor(silentMs / SECOND)} s ago.`;
}

export const wholeMinutes = (ms: number) => Math.floor(ms / MINUTE);

/** The browser time now. While isOn, it changes each second. */
function useTick(isOn: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isOn) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isOn]);
  return now;
}

/** The browser time when the value became true for this key, or null while it is false */
function useTimeWhenTrue(key: string | null, isTrue: boolean): number | null {
  const [since, setSince] = useState<{ key: string | null; at: number } | null>(null);
  useEffect(() => {
    if (!isTrue) setSince(null);
    else setSince(current => (current?.key === key ? current : { key, at: Date.now() }));
  }, [key, isTrue]);
  return isTrue && since?.key === key ? since.at : null;
}
