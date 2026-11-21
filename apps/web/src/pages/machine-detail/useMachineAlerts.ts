import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMachineAlerts, type MachineAlert } from '../../api/alerts';
import { useRefreshWhileVisible } from '../../hooks/useRefreshWhileVisible';

/** vmalert checks the rules every 15 seconds, so the list loads again as often while the page is in view */
const RELOAD_EVERY_MS = 15_000;

/** The alerts of one machine in the last week. `failed` is true when the last load did not work. */
export function useMachineAlerts(machineId: string) {
  const [alerts, setAlerts] = useState<MachineAlert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The machine of the page now, so a late reply for another machine, or after unmount, changes nothing */
  const shownMachine = useRef<string | null>(machineId);

  const load = useCallback(() => {
    const isCurrent = () => shownMachine.current === machineId;
    fetchMachineAlerts(machineId)
      .then(found => {
        if (!isCurrent()) return;
        setAlerts(found);
        setFailed(false);
      })
      .catch(() => {
        if (isCurrent()) setFailed(true);
      })
      .finally(() => {
        if (isCurrent()) setLoaded(true);
      });
  }, [machineId]);

  useEffect(() => {
    shownMachine.current = machineId;
    setAlerts([]);
    setLoaded(false);
    load();
    return () => {
      shownMachine.current = null;
    };
  }, [machineId, load]);
  useRefreshWhileVisible(load, RELOAD_EVERY_MS);

  return { alerts, loaded, failed };
}

export type MachineAlerts = ReturnType<typeof useMachineAlerts>;
