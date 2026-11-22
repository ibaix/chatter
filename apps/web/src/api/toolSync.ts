import type { ToolSyncState } from '../types';
import { api } from './client';

const FAILURE_TEXT = 'Could not read the tool table';

/**
 * Why a Sync gave no new tool table. The screen uses it to remove the error when the error no longer applies.
 * 'other': an error that the screen cannot follow, for example a page of a proxy.
 */
export type SyncRefusal =
  | { outcome: 'failed'; toolSync: ToolSyncState }
  | { outcome: 'too-soon'; retryAfterSeconds: number }
  | { outcome: 'busy' | 'not-connected' | 'other' };

/** A Sync that gave no new tool table: the text of the server, and why */
export class ToolSyncError extends Error {
  constructor(message: string, readonly refusal: SyncRefusal) {
    super(message);
  }
}

/** The error body of the Sync route */
interface SyncErrorBody {
  error?: string;
  outcome?: string;
  toolSync?: ToolSyncState;
  retryAfterSeconds?: number;
}

function refusalOf(body: SyncErrorBody): SyncRefusal {
  if (body.outcome === 'failed' && body.toolSync) return { outcome: 'failed', toolSync: body.toolSync };
  if (body.outcome === 'too-soon' && typeof body.retryAfterSeconds === 'number') {
    return { outcome: 'too-soon', retryAfterSeconds: body.retryAfterSeconds };
  }
  if (body.outcome === 'busy' || body.outcome === 'not-connected') return { outcome: body.outcome };
  return { outcome: 'other' };
}

/** Ask the server to read the tool table of the machine now. Throws a ToolSyncError with the server's reason. */
export async function syncTools(machineId: string): Promise<ToolSyncState> {
  const response = await api.machine[':id'].tools.sync.$post({ param: { id: machineId } });
  // A proxy can send a page that is not JSON. Then the general text is used.
  const body: SyncErrorBody & { toolSync?: ToolSyncState } = await response.json().catch(() => ({}));
  if (response.ok && body.toolSync) return body.toolSync;
  throw new ToolSyncError(body.error || FAILURE_TEXT, refusalOf(body));
}
