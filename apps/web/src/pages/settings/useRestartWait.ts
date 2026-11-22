import { useEffect, useRef, useState } from 'react';
import { fetchInstance } from '../../api/diagnostics';

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
 * Waits for a new Chatter process after a restart. Each process has its own random name (instance), so an answer
 * of the old process (before it stops) does not count. No server time is compared with the browser clock.
 * When the name of the old process is not known, a process that answers after a time with no answer counts as new.
 */
export function useRestartWait() {
  const [phase, setPhase] = useState<RestartPhase>('idle');
  const oldInstance = useRef<string | null>(null);
  const sawNoAnswer = useRef(false);
  // Only compared with the browser clock
  const askedAt = useRef(0);

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'late') return;
    const timer = setInterval(async () => {
      const instance = await fetchInstance();
      if (instance === null) sawNoAnswer.current = true;
      const isNew = instance !== null && (oldInstance.current === null ? sawNoAnswer.current : instance !== oldInstance.current);
      if (isNew) setPhase('back');
      else if (Date.now() - askedAt.current > RESTART_LATE_MS) setPhase('late');
    }, RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  /** Before the restart request: get the name of the process that runs now */
  const prepare = async () => {
    oldInstance.current = await fetchInstance();
  };

  /** After the restart request: start to wait */
  const wait = () => {
    sawNoAnswer.current = false;
    askedAt.current = Date.now();
    setPhase('waiting');
  };

  return { phase, prepare, wait };
}
