import { Hono } from 'hono';
import { requirePermission } from '../auth/authRoutes.js';
import { getUploadEventById, getUploadEvents, getUploadFiles } from '../storage/database.js';
import { checkedParam, checkedQuery } from './checks.js';
import { notFound } from './responses.js';
import { uploadEventParams, uploadFileParams, uploadListQuery } from './schemas.js';

const DEFAULT_FILE_LIMIT = 50;

/** The record of files that were sent to each machine. Each role sees the names and dates; only read-files gives the text. */
export function uploadHistoryRoutes() {
  return new Hono()
    // The files sent to a machine, one entry for each file name
    .get('/machine/:id/uploads', checkedQuery(uploadListQuery), async c => {
      const limit = parseInt(c.req.valid('query').limit ?? '') || DEFAULT_FILE_LIMIT;
      return c.json(await getUploadFiles(c.req.param('id'), limit));
    })

    // Each time one file was sent
    .get('/machine/:id/uploads/:fileId/events', checkedParam(uploadFileParams), async c => {
      const { id, fileId } = c.req.valid('param');
      return c.json(await getUploadEvents(id, fileId));
    })

    // One send, with the file content
    .get('/machine/:id/uploads/events/:eventId', requirePermission('read-files'), checkedParam(uploadEventParams), async c => {
      const { id, eventId } = c.req.valid('param');
      const event = await getUploadEventById(id, eventId);
      return event ? c.json(event) : notFound(c, 'Upload event');
    });
}
