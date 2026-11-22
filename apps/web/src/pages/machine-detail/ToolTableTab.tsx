import { cn } from '@toolpath/ui';
import { useState } from 'react';
import { syncTools } from '../../api/toolSync';
import { Button } from '../../components/ui/Button';
import { CELL, HEAD_CELL, HEAD_ROW, ROW, TABLE } from '../../components/ui/table';
import type { ToolInfo, ToolSyncState, ToolTable } from '../../types';
import { errorMessageOf } from '../../utils/errorMessage';

interface ToolTableTabProps {
  machineId: string;
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

/** When Chatter read the tool table, and the Sync button that reads it now */
function ToolSyncBar({ machineId, toolSync }: { machineId: string; toolSync: ToolSyncState }) {
  const [syncing, setSyncing] = useState(false);
  /** The error of the last Sync, and the last read of the server when the Sync started */
  const [error, setError] = useState<{ text: string; serverAttemptAt: string | null } | null>(null);
  const [fromSync, setFromSync] = useState<ToolSyncState | null>(null);
  const state = newerState(toolSync, fromSync);
  const running = syncing || state.running;

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      setFromSync(await syncTools(machineId));
    } catch (err) {
      setError({ text: errorMessageOf(err, 'Could not read the tool table'), serverAttemptAt: toolSync.lastAttemptAt });
    } finally {
      setSyncing(false);
    }
  };

  // A newer read of the server replaces the error of the Sync
  const syncError = error && error.serverAttemptAt === toolSync.lastAttemptAt ? error.text : null;
  const shownError = syncError ?? state.error;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3 text-zinc-200">
      <span>{running ? 'Syncing…' : state.lastSyncAt ? `Synced ${timeOf(state.lastSyncAt)}` : 'Not synced yet'}</span>
      <Button size="sm" onClick={() => void sync()} disabled={running}>Sync</Button>
      <span className="text-xs">Chatter reads the tool table when the machine runs no program, at most each 10 minutes.</span>
      {shownError && !running && <span role="alert" className="w-full text-alarm-soft">{shownError}</span>}
    </div>
  );
}

/** One row for each tool, with its lengths and wear. The tool in the spindle is marked. */
export function ToolTableTab({ machineId, toolSync, toolTable, hasPocketInfo, spindleTool }: ToolTableTabProps) {
  const toolsByPocket = Object.entries(toolTable) as [string, ToolInfo][];

  return (
    <>
      {toolSync && <ToolSyncBar machineId={machineId} toolSync={toolSync} />}
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
