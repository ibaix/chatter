import { Hono, type Context } from 'hono';
import { UPDATE_FILE_LIMIT_BYTES } from '@local-chatter/shared';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { checkedJson } from './checks.js';
import { rawFileUpload } from './rawFileUpload.js';
import { updateSettingsSchema } from './schemas.js';
import { LIMIT_MESSAGE, UpdateRefusedError, type UpdateService, type UpdatesReport } from '../updates/UpdateService.js';

const [requireRawFile, requireLengthFirst, updateFileSizeLimit] = rawFileUpload('the update file', UPDATE_FILE_LIMIT_BYTES, LIMIT_MESSAGE);

/** The new report, or the reply for a request that Chatter cannot do now */
async function reportOrRefusal(c: Context, action: () => Promise<UpdatesReport>) {
  try {
    return c.json(await action());
  } catch (error) {
    if (error instanceof UpdateRefusedError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

/**
 * Settings > Updates: see the version and the update status, upload or download an update file,
 * ask the helper to check or install it, and turn the check on GitHub on or off.
 * Only an admin can do this.
 */
export function updateRoutes(updates: UpdateService) {
  const canManageUpdates = requirePermission('manage-updates');
  return new Hono<LoggedInEnv>()
    .get('/updates/status', canManageUpdates, async c => c.json(await updates.report()))

    .post('/updates/file', canManageUpdates, requireRawFile, requireLengthFirst, updateFileSizeLimit, async c => {
      const body = c.req.raw.body;
      if (!body) return c.json({ error: 'No update file was sent' }, 400);
      const size = Number(c.req.header('Content-Length'));
      return reportOrRefusal(c, () => updates.receiveFile(body, size, c.var.user.username));
    })

    .post('/updates/download', canManageUpdates, c => reportOrRefusal(c, () => updates.download(c.var.user.username)))

    .put('/updates/settings', canManageUpdates, checkedJson(updateSettingsSchema), async c =>
      c.json(await updates.setCheckGitHub(c.req.valid('json').checkGitHub)))

    .post('/updates/check', canManageUpdates, c => reportOrRefusal(c, () => updates.request('check', c.var.user.username)))

    // The lines of the helper, so nobody needs SSH (journalctl) to see what it did. Only a newer helper writes them.
    .get('/updates/helper-log', canManageUpdates, async c => {
      const text = await updates.helperLog();
      if (text === null) return c.json({ error: 'The update helper of this Pi writes no log that Chatter can read. A new card image is necessary for this.' }, 404);
      return c.body(text, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    })

    // The helper stops Chatter during the install. The page asks for the status again until Chatter is back.
    .post('/updates/install', canManageUpdates, c => reportOrRefusal(c, () => updates.request('install', c.var.user.username)));
}
