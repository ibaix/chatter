import { Hono, type Context } from 'hono';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { ARCHIVE_LIMITS } from '../history-backup/archive.js';
import { BackupRefusedError, tooLargeMessage, type BackupMachine, type HistoryBackup } from '../history-backup/HistoryBackup.js';
import { createLogger } from '../logging/logger.js';
import type { HardwarePoller } from '../polling/poller.js';
import { checkedJson } from './checks.js';
import { rawFileUpload } from './rawFileUpload.js';
import { notFound } from './responses.js';
import { historyBackupSchema, historyRestoreSchema } from './schemas.js';

const log = createLogger('history-backup');

/** The reply of a request that Chatter refused, or of a machine history that does not answer */
async function replyOrRefusal<Reply extends Response>(c: Context, action: () => Promise<Reply>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof BackupRefusedError) return c.json({ error: error.message }, error.status);
    log.error('History backup or restore failed', { error });
    return c.json({ error: 'The machine history is not available now. Try again later.' }, 503);
  }
}

function machineOf(poller: HardwarePoller, id: string): BackupMachine | null {
  const machine = poller.getMachine(id);
  return machine ? { id: machine.id, name: machine.name, type: machine.type } : null;
}

/**
 * The machine Settings tab, Advanced > Backup and restore.
 * A user who manages machines can back up the history of a machine. Only an admin (manage-chatter) can restore,
 * because a restore writes into the history.
 */
export function historyBackupRoutes(poller: HardwarePoller, backups: HistoryBackup) {
  const canManageMachines = requirePermission('manage-machines');
  const canManageChatter = requirePermission('manage-chatter');
  const [requireRawFile, requireLengthFirst, fileSizeLimit] = rawFileUpload('the backup file', ARCHIVE_LIMITS.archiveBytes, tooLargeMessage());

  return new Hono<LoggedInEnv>()
    // Step 1 of a backup: read the history into files. Gives the id for the download.
    .post('/machine/:id/history-backup', canManageMachines, checkedJson(historyBackupSchema), async c => {
      const machine = machineOf(poller, c.req.param('id'));
      if (!machine) return notFound(c);
      const { from = null, to = Date.now(), averagesOnly = false } = c.req.valid('json');
      return replyOrRefusal(c, async () => {
        const { id, fileName, manifest } = await backups.prepareBackup(machine, { from, to, averagesOnly }, c.var.user.username, c.req.raw.signal);
        return c.json({ id, fileName, parts: manifest.parts, data: manifest.data });
      });
    })

    // Step 2 of a backup: the .tar.gz file. Its files on the disk are deleted after the download.
    .get('/machine/:id/history-backup/:backupId', canManageMachines, c => {
      try {
        const { fileName, stream } = backups.download(c.req.param('backupId'), c.req.param('id'), c.var.user.username);
        return c.body(stream, 200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store',
        });
      } catch (error) {
        if (error instanceof BackupRefusedError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    })

    // Step 1 of a restore: receive and check the file. Nothing is written yet. Gives the preview.
    .post('/machine/:id/history-restore', canManageChatter, requireRawFile, requireLengthFirst, fileSizeLimit, async c => {
      const machine = machineOf(poller, c.req.param('id'));
      if (!machine) return notFound(c);
      const body = c.req.raw.body;
      if (!body) return c.json({ error: 'No backup file was sent' }, 400);
      const size = Number(c.req.header('Content-Length'));
      return replyOrRefusal(c, async () => c.json(await backups.receiveRestore(body, size, machine, c.var.user.username)));
    })

    // Step 2 of a restore: the user confirmed the preview
    .post('/machine/:id/history-restore/:restoreId', canManageChatter, checkedJson(historyRestoreSchema), async c => {
      const machine = machineOf(poller, c.req.param('id'));
      if (!machine) return notFound(c);
      const options = c.req.valid('json');
      return replyOrRefusal(c, async () => c.json(await backups.restore(c.req.param('restoreId'), machine, options, c.var.user.username)));
    })

    .delete('/machine/:id/history-restore/:restoreId', canManageChatter, async c => replyOrRefusal(c, async () => {
      await backups.cancelRestore(c.req.param('restoreId'), c.req.param('id'));
      return c.json({ message: 'The restore file is deleted' });
    }));
}
