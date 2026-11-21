import type { ToolSyncState } from '../types';
import { api } from './client';
import { jsonOrThrow } from './replies';

/** Ask the server to read the tool table of the machine now. Throws an error with the server's reason. */
export async function syncTools(machineId: string): Promise<ToolSyncState> {
  const response = await api.machine[':id'].tools.sync.$post({ param: { id: machineId } });
  const { toolSync } = await jsonOrThrow<{ toolSync: ToolSyncState }>(response, 'Could not read the tool table');
  return toolSync;
}
