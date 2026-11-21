import { useEffect, useRef, useState } from 'react';
import { fetchStartTime } from '../../api/diagnostics';

/** How often the page asks if Chatter is back */
export const RESTART_POLL_MS = 2000;
/** After this time, the page says that Chatter did not come back, and what to check */
export const RESTART_LATE_MS = 5 * 60_000;

/**
 * idle: no restart.
 * waiting: Chatter (or the Pi) restarts, and the page asks each 2 seconds.
 * back: a new Chatter process answers.
 * late: no new Chatter process after 5 minutes. The page continues to ask.
 */
export type RestartPhase = 'idle' | 'waiting' | 'back' | 'late';

/**
 * Waits for a new Chatter process after a restart. A new process has a later start time than the old one,
 * so an answer of the old process (before it stops) does not count.
 */
export function useRestartWait() {
  const [phase, setPhase] = useState<RestartPhase>('idle');
  const oldStart = useRef(0);
  const askedAt = useRef(0);

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'late') return;
    const timer = setInterval(async () => {
      const start = await fetchStartTime();
      // The start time comes from the uptime, so it can move a little. A new process started after the request.
      if (start !== null && start > Math.max(oldStart.current, askedAt.current - RESTART_POLL_MS)) setPhase('back');
      else if (Date.now() - askedAt.current > RESTART_LATE_MS) setPhase('late');
    }, RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  /** Start to wait. `startedAt` is the start time of the Chatter process before the restart. */
  const wait = (startedAt: string) => {
    oldStart.current = Date.parse(startedAt);
    askedAt.current = Date.now();
    setPhase('waiting');
  };

  return { phase, wait };
}
