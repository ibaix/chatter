import { cn } from '@toolpath/ui';
import { useEffect, useState } from 'react';
import { ToolSyncError, syncTools, type SyncRefusal } from '../../api/toolSync';
import { Button } from '../../components/ui/Button';
import { CELL, HEAD_CELL, HEAD_ROW, ROW, TABLE } from '../../components/ui/table';
import type { ToolInfo, ToolSyncState, ToolTable } from '../../types';
import { errorMessageOf } from '../../utils/errorMessage';

interface ToolTableTabProps {
  machineId: string;
  /** True while Chatter is connected to the machine */
  connected: boolean;
  /** The reads of the tool table. Only a machine that reads its tool table apart from the state polls (Brother) has it. */
  toolSync?: ToolSyncState;
  toolTable: ToolTable;
  /** True when the machine reports which pocket holds each tool */
  hasPocketInfo: boolean;
  /** The tool in the spindle now, when the machine sends it */
  spindleTool: number | undefined;
}

/** A length or a diameter with 4 decimal places, or a dash when the machine does not send it */
const formatMeasure = (value: number | undefined) => value?.toFixed(4) ?? '—';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The newer of two states, by the end of their last read */
function newerState(fromStatus: ToolSyncState, fromSync: ToolSyncState | null): ToolSyncState {
  if (!fromSync) return fromStatus;
  return (fromStatus.lastAttemptAt ?? '') > (fromSync.lastAttemptAt ?? '') || fromStatus.running ? fromStatus : fromSync;
}

/** The error of a Sync that the server refused before it read the tools */
interface RefusalError {
  text: string;
  refusal: Exclude<SyncRefusal, { outcome: 'failed' }>;
  /** The last read of the server when the Sync started */
  serverAttemptAt: string | null;
  /** True after the screen showed the cause of the refusal: the machine offline, or a read that runs */
  causeSeen: boolean;
}

/** True while the cause of a refusal shows on the screen */
function causeShows(refusal: RefusalError['refusal'], connected: boolean, toolSync: ToolSyncState): boolean {
  if (refusal.outcome === 'not-connected') return !connected;
  if (refusal.outcome === 'busy') return toolSync.running;
  return false;
}

/**
 * True while the error of a refused Sync still applies. A newer read of the server removes each such error.
 * "Not connected" goes when the machine is connected again, and "busy" when the read that ran ends.
 * "Too soon" goes after its seconds (see the timer in useRefusalError). Another error stays until the newer read.
 */
function stillApplies(error: RefusalError, connected: boolean, toolSync: ToolSyncState): boolean {
  if (toolSync.lastAttemptAt !== error.serverAttemptAt) return false;
  if (error.refusal.outcome === 'not-connected' || error.refusal.outcome === 'busy') {
    return !error.causeSeen || causeShows(error.refusal, connected, toolSync);
  }
  return true;
}

/** The error of the last refused Sync, and its text while it still applies */
function useRefusalError(connected: boolean, toolSync: ToolSyncState) {
  const [error, setError] = useState<RefusalError | null>(null);

  // The cause of a refusal can show on the screen after the reply of the server
  if (error && !error.causeSeen && causeShows(error.refusal, connected, toolSync)) setError({ ...error, causeSeen: true });

  // The server accepts a Sync again after the seconds that it gave
  const retryAfterSeconds = error?.refusal.outcome === 'too-soon' ? error.refusal.retryAfterSeconds : null;
  useEffect(() => {
    if (retryAfterSeconds === null) return;
    const timer = setTimeout(() => setError(null), retryAfterSeconds * 1000);
    return () => clearTimeout(timer);
  }, [error, retryAfterSeconds]);

  const text = error && stillApplies(error, connected, toolSync) ? error.text : null;
  return { text, setError };
}

/** When Chatter read the tool table, and the Sync button that reads it now */
function ToolSyncBar({ machineId, connected, toolSync }: { machineId: string; connected: boolean; toolSync: ToolSyncState }) {
  const [syncing, setSyncing] = useState(false);
  const { text: refusalText, setError } = useRefusalError(connected, toolSync);
  /** The state in the reply of the last Sync. A failed read has its error in it. */
  const [fromSync, setFromSync] = useState<ToolSyncState | null>(null);
  const state = newerState(toolSync, fromSync);
  const running = syncing || state.running;

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      setFromSync(await syncTools(machineId));
    } catch (err) {
      // A read that failed has its error in its state, as an automatic read does, so the screen shows one text for it
      if (err instanceof ToolSyncError && err.refusal.outcome === 'failed') setFromSync(err.refusal.toolSync);
      else setError(refusalErrorOf(err, toolSync, connected));
    } finally {
      setSyncing(false);
    }
  };

  const shownError = refusalText ?? state.error;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3 text-zinc-200">
      <span>{running ? 'Syncing…' : state.lastSyncAt ? `Synced ${timeOf(state.lastSyncAt)}` : 'Not synced yet'}</span>
      <Button size="sm" onClick={() => void sync()} disabled={running}>Sync</Button>
      <span className="text-xs">Chatter reads the tool table when the machine runs no program and the last read is more than 10 minutes old.</span>
      {shownError && !running && <span role="alert" className="w-full text-alarm-soft">{shownError}</span>}
    </div>
  );
}

/** The error of a refused Sync. The time of the last read and `connected` are the ones when the Sync started. */
function refusalErrorOf(err: unknown, toolSync: ToolSyncState, connected: boolean): RefusalError {
  const refusal = err instanceof ToolSyncError && err.refusal.outcome !== 'failed' ? err.refusal : { outcome: 'other' as const };
  return {
    text: errorMessageOf(err, 'Could not read the tool table'),
    refusal,
    serverAttemptAt: toolSync.lastAttemptAt,
    causeSeen: causeShows(refusal, connected, toolSync),
  };
}

/** One row for each tool, with its lengths and wear. The tool in the spindle is marked. */
export function ToolTableTab({ machineId, connected, toolSync, toolTable, hasPocketInfo, spindleTool }: ToolTableTabProps) {
  const toolsByPocket = Object.entries(toolTable) as [string, ToolInfo][];

  return (
    <>
      {toolSync && <ToolSyncBar machineId={machineId} connected={connected} toolSync={toolSync} />}
      <div className="flex flex-wrap justify-between gap-3 px-4 py-3 text-zinc-200">
        <span>The lengths and diameters are in the machine's units. The tool in the spindle is marked.</span>
        {!hasPocketInfo && <span>This machine does not send the pocket of each tool.</span>}
      </div>
      <div className="overflow-x-auto">
        <table className={cn(TABLE, 'min-w-[35rem] font-mono')}>
          <thead>
            <tr className={cn(HEAD_ROW, 'text-right font-body')}>
              {hasPocketInfo && <th scope="col" className={cn(HEAD_CELL, 'text-left')}>Pocket</th>}
              <th scope="col" className={cn(HEAD_CELL, 'text-left')}>Tool</th>
              <th scope="col" className={HEAD_CELL}>Length</th>
              <th scope="col" className={HEAD_CELL}>Length wear</th>
              <th scope="col" className={HEAD_CELL}>Diameter</th>
              <th scope="col" className={HEAD_CELL}>Diameter wear</th>
            </tr>
          </thead>
          <tbody>
            {toolsByPocket.map(([pocket, tool]) => {
              const isInSpindle = tool.toolNum === spindleTool;
              return (
                <tr key={pocket} className={cn(ROW, 'text-right', isInSpindle && 'bg-primary/14')}>
                  {hasPocketInfo && <td className={cn(CELL, 'text-left')}>P{pocket}</td>}
                  <th scope="row" className={cn(CELL, 'text-left font-medium')}>
                    T{tool.toolNum}
                    {tool.name && <span className="ml-2 font-body text-xs text-zinc-200">{tool.name}</span>}
                    {isInSpindle && <span className="ml-2 font-body text-[0.6875rem] font-bold text-primary-text">IN SPINDLE</span>}
                  </th>
                  <td className={CELL}>{formatMeasure(tool.length)}</td>
                  <td className={CELL}>{formatMeasure(tool.lengthWear)}</td>
                  <td className={CELL}>{formatMeasure(tool.diameter)}</td>
                  <td className={CELL}>{formatMeasure(tool.diameterWear)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
