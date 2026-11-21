import { Hono } from 'hono';
import { requirePermission, type LoggedInEnv } from '../auth/authRoutes.js';
import { supportBundle, type BundleSources } from '../diagnostics/supportBundle.js';
import { createLogger } from '../logging/logger.js';
import { downloadName } from './logs.js';

const log = createLogger('diagnostics');

/** Settings > Diagnostics: "Download support bundle". Only an admin can do this. */
export function supportBundleRoutes(sources: BundleSources) {
  return new Hono<LoggedInEnv>()
    .get('/support-bundle', requirePermission('manage-chatter'), async c => {
      log.info('Support bundle downloaded', { user: c.var.user.username });
      const now = sources.now?.() ?? new Date();
      return c.body(await supportBundle(sources), 200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${downloadName('support', now, 'tar.gz')}"`,
        'Cache-Control': 'no-store',
      });
    });
}
