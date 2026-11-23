import type { MachineUpdate } from '../types';
import { api } from './client';
import { errorOf } from './replies';

/**
 * Save a change to the settings of a machine. Throws an error with the server's reason,
 * for example when a new IP address needs the saved password again.
 */
export async function saveMachineUpdate(id: string, updates: MachineUpdate): Promise<void> {
  const error = await errorOf(await api.machine[':id'].$put({ param: { id }, json: updates }), 'Could not save the machine settings');
  if (error) throw new Error(error);
}
