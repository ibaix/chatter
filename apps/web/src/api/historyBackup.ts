import type { InferResponseType } from 'hono/client';
import { api } from './client';
import { jsonOrThrow } from './replies';
import { sendWithProgress } from './sendWithProgress';

/** The backup and restore of the history of one machine (the Settings tab of a machine, Advanced) */

const machine = api.machine[':id'];

export type PreparedBackup = InferResponseType<typeof machine['history-backup']['$post'], 200>;
export type RestorePreview = InferResponseType<typeof machine['history-restore']['$post'], 200>;
export type RestoreResult = InferResponseType<typeof machine['history-restore'][':restoreId']['$post'], 200>;

export interface BackupChoice {
  /** Milliseconds since 1970. Null for all the history. */
  from: number | null;
  to?: number;
  averagesOnly: boolean;
}

/** Chatter reads the history into a file. Then the browser downloads it from backupDownloadUrl(). */
export async function prepareBackup(machineId: string, choice: BackupChoice): Promise<PreparedBackup> {
  return jsonOrThrow(await machine['history-backup'].$post({ param: { id: machineId }, json: choice }), 'Could not back up the history');
}

/** The address of the .tar.gz file of a prepared backup. It works one time. */
export function backupDownloadUrl(machineId: string, backupId: string): string {
  return machine['history-backup'][':backupId'].$url({ param: { id: machineId, backupId } }).pathname;
}

/** Send a backup file, and tell how much is sent (0 to 1). Chatter checks all of it and gives a preview. */
export async function uploadRestoreFile(machineId: string, file: File, onProgress: (sent: number) => void): Promise<RestorePreview> {
  const address = machine['history-restore'].$url({ param: { id: machineId } }).pathname;
  return jsonOrThrow(await sendWithProgress(address, file, onProgress), 'Could not read the backup file');
}

/** Write the history of the received file into the machine */
export async function confirmRestore(machineId: string, restoreId: string, alertRules: boolean): Promise<RestoreResult> {
  return jsonOrThrow(
    await machine['history-restore'][':restoreId'].$post({ param: { id: machineId, restoreId }, json: { alertRules } }),
    'Could not restore the history',
  );
}

/** Delete the received file without a restore */
export async function cancelRestore(machineId: string, restoreId: string): Promise<void> {
  await jsonOrThrow(await machine['history-restore'][':restoreId'].$delete({ param: { id: machineId, restoreId } }), 'Could not delete the file');
}
