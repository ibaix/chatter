import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { UnofficialStatusCode } from 'hono/utils/http-status';
import { FILE_LIST_CUT_SHORT_HEADER, PROGRAM_UPLOAD_LIMIT_BYTES } from '@local-chatter/shared';
import type { HardwarePoller } from '../polling/poller.js';
import { recordUpload } from '../storage/database.js';
import { attachmentHeader, downloadAsStream } from './fileDownload.js';
import { requirePermission } from '../auth/authRoutes.js';
import { checkedForm, checkedQuery } from './checks.js';
import { allowLongUpload } from '../webServerOptions.js';
import { machineErrorReply, notFound } from './responses.js';
import { streamWithoutErrorText } from './streamReplies.js';
import { createLogger } from '../logging/logger.js';
import { batchUploadForm, filePathQuery, fileTreeQuery, readTargetNames, uploadForm } from './schemas.js';

const log = createLogger('machine-files');
/** The status of a reply that nobody reads, because the browser closed the connection first (as nginx logs it) */
const CLIENT_CLOSED_REQUEST = 499 as UnofficialStatusCode;

const ROOT_FOLDER = '.';
const DEFAULT_TREE_DEPTH = '2';
/** FTPClient puts this in its error when a file is there and overwrite is off */
const FILE_EXISTS_TEXT = 'already exists';

/** A file from the request, read into memory. It goes straight on to the machine. */
interface ReceivedFile {
  name: string;
  content: Buffer;
}

/** For each remote path: the file, its own name, and the name on the machine */
interface UploadPlan {
  files: Array<{ remotePath: string; source: Buffer }>;
  fileAt: Record<string, ReceivedFile>;
  targetNameAt: Record<string, string>;
}

/**
 * The server holds the files of an upload in memory, and a Pi has only 512 MB.
 * bodyLimit refuses a body that says it is too large before it reads it, and stops reading at the limit.
 */
const programSizeLimit = bodyLimit({
  maxSize: PROGRAM_UPLOAD_LIMIT_BYTES,
  onError: c => c.json({ error: `The files are too large. Send at most ${PROGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024} MB at one time.` }, 413),
});

/**
 * The most uploads that hold their files in memory at the same time, for all machines. Each machine has its own FTP
 * queue, so the queue does not limit this. An upload of 32 MB uses about twice that in memory (the form and the copy),
 * and a Pi can have only 512 MB. Two, so that one upload can wait for a busy machine while another machine gets a file.
 */
const MAX_UPLOADS_AT_ONCE = 2;
const UPLOADS_BUSY_TEXT = 'Chatter is busy with other uploads. Try again later.';

/**
 * Refuse an upload with 503 while MAX_UPLOADS_AT_ONCE uploads run. It comes before the route reads the body, so a
 * refused upload uses no memory for its files. Each call gives its own count, so each server has its own limit.
 */
function limitUploadsAtOnce() {
  let uploadCount = 0;
  return createMiddleware(async (c, next) => {
    if (uploadCount >= MAX_UPLOADS_AT_ONCE) return c.json({ error: UPLOADS_BUSY_TEXT }, 503);
    uploadCount += 1;
    try {
      await next();
    } finally {
      uploadCount -= 1;
    }
  });
}

/**
 * The reply for an error of a file task. When the browser left, the task stopped because of that, and nobody reads the
 * reply. So the log gets no error.
 */
function fileTaskErrorReply(error: Error, c: Context) {
  if (!c.req.raw.signal.aborted) return machineErrorReply(error, c);
  log.debug('A machine file task stopped, because the browser left', { method: c.req.method, path: c.req.path, error });
  return c.body(null, CLIENT_CLOSED_REQUEST);
}

/** The form sends booleans as the text "true" or "false" */
const isTrueText = (value: string | undefined) => value === 'true';
const fileNameOf = (remotePath: string) => remotePath.slice(remotePath.lastIndexOf('/') + 1);

async function receive(file: File): Promise<ReceivedFile> {
  return { name: file.name, content: Buffer.from(await file.arrayBuffer()) };
}

function joinRemotePath(basePath: string, fileName: string): string {
  return basePath.endsWith('/') ? `${basePath}${fileName}` : `${basePath}/${fileName}`;
}

function planUpload(files: ReceivedFile[], basePath: string, targetNames: Record<string, string>): UploadPlan {
  const plan: UploadPlan = { files: [], fileAt: {}, targetNameAt: {} };
  for (const file of files) {
    // Object.hasOwn, so that a file named "constructor" does not get a name from the object prototype
    const targetName = (Object.hasOwn(targetNames, file.name) && targetNames[file.name]) || file.name;
    const remotePath = joinRemotePath(basePath, targetName);
    // The FTP client may report the path with or without the first "/"
    for (const key of [remotePath, remotePath.replace(/^\//, '')]) {
      plan.fileAt[key] = file;
      plan.targetNameAt[key] = targetName;
    }
    plan.files.push({ remotePath, source: file.content });
  }
  return plan;
}

/** The reply for one file of a batch upload */
function describeUpload(plan: UploadPlan, remotePath: string) {
  return {
    filename: plan.fileAt[remotePath]?.name || fileNameOf(remotePath),
    targetName: plan.targetNameAt[remotePath] || fileNameOf(remotePath),
    path: remotePath,
  };
}

/**
 * Save a sent file in the upload history.
 * The file is on the machine already, so an error here does not make the send fail.
 * The error goes to the log, and the user does not get the database text.
 */
async function recordSentFile(machineId: string, file: ReceivedFile, nameOnMachine: string, remotePath: string) {
  try {
    await recordUpload(machineId, file.name, nameOnMachine, remotePath, file.content.toString('utf-8'));
  } catch (error) {
    log.error('The file is on the machine, but Chatter could not save it in the upload history', { machineId, path: remotePath, error });
  }
}

async function recordSentFiles(machineId: string, plan: UploadPlan, sentPaths: string[]) {
  for (const remotePath of sentPaths) {
    const file = plan.fileAt[remotePath];
    if (file) await recordSentFile(machineId, file, plan.targetNameAt[remotePath], remotePath);
  }
}

/** Read, send, and delete the program files on a machine (over FTP) */
export function machineFileRoutes(poller: HardwarePoller) {
  const canReadFiles = requirePermission('read-files');
  const canSendFiles = requirePermission('send-files');
  const uploadLimit = limitUploadsAtOnce();
  return new Hono()
    // The machine refused or failed, so its reply text goes to the user
    .onError(fileTaskErrorReply)
    // Names, sizes and dates only. Each role can see them.
    .get('/machine/:id/files', checkedQuery(fileTreeQuery), async c => {
      const { path = ROOT_FOLDER, depth = DEFAULT_TREE_DEPTH } = c.req.valid('query');
      const connector = poller.getConnector(c.req.param('id'));
      if (!connector) return notFound(c);

      const { nodes, isCutShort } = await connector.readFileTree(path, parseInt(depth), c.req.raw.signal);
      if (isCutShort) c.header(FILE_LIST_CUT_SHORT_HEADER, 'true');
      return c.json(nodes);
    })

    .get('/machine/:id/files/download', canReadFiles, checkedQuery(filePathQuery), async c => {
      const { path } = c.req.valid('query');
      const connector = poller.getConnector(c.req.param('id'));
      if (!connector) return notFound(c);

      const browserLeft = c.req.raw.signal;
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await downloadAsStream(connector, path, browserLeft);
      } catch (error) {
        if (!browserLeft.aborted) throw error;
        // The browser left before the first bytes, and the download stopped. Nobody reads this reply.
        log.debug('The program download stopped because the browser left before the first bytes', { path: c.req.path, error });
        return c.body(null, CLIENT_CLOSED_REQUEST);
      }
      return c.body(streamWithoutErrorText(c, stream, 'The program download'), 200, {
        'Content-Disposition': attachmentHeader(fileNameOf(path)),
        'Content-Type': 'application/octet-stream',
      });
    })

    .post('/machine/:id/files/upload', canSendFiles, uploadLimit, allowLongUpload, programSizeLimit, checkedForm(uploadForm), async c => {
      const machineId = c.req.param('id');
      const { file, path: remotePath, overwrite, targetName } = c.req.valid('form');
      const connector = poller.getConnector(machineId);
      if (!connector) return notFound(c);

      const received = await receive(file);
      const nameOnMachine = targetName || received.name;
      try {
        // The signal of the request: a browser that leaves stops the upload, also while it waits for the machine
        await connector.uploadFile(remotePath, received.content, isTrueText(overwrite), c.req.raw.signal);
      } catch (error) {
        if (error instanceof Error && error.message.includes(FILE_EXISTS_TEXT)) {
          return c.json({ error: error.message }, 409);
        }
        throw error;
      }
      await recordSentFile(machineId, received, nameOnMachine, remotePath);
      return c.json({
        message: 'File uploaded successfully',
        filename: received.name,
        targetName: nameOnMachine,
        path: remotePath,
      });
    })

    // Send several files. Each file passes or fails on its own.
    .post('/machine/:id/files/upload-batch', canSendFiles, uploadLimit, allowLongUpload, programSizeLimit, checkedForm(batchUploadForm), async c => {
      const machineId = c.req.param('id');
      const { files, basePath, overwrite, targetNames } = c.req.valid('form');
      const connector = poller.getConnector(machineId);
      if (!connector) return notFound(c);

      // batchUploadForm checked targetNames, so this error is only a second guard
      const names = readTargetNames(targetNames);
      if (!names.ok) return c.json({ error: names.error }, 400);
      const received = await Promise.all(files.map(receive));
      const plan = planUpload(received, basePath, names.names);
      const results = await connector.uploadFiles(plan.files, isTrueText(overwrite), c.req.raw.signal);
      await recordSentFiles(machineId, plan, results.success.map(sent => sent.remotePath));

      return c.json({
        success: results.success.map(sent => describeUpload(plan, sent.remotePath)),
        failed: results.failed.map(failed => ({
          ...describeUpload(plan, failed.remotePath),
          error: failed.error || 'Unknown error',
        })),
      });
    })

    .delete('/machine/:id/files', canSendFiles, checkedQuery(filePathQuery), async c => {
      const { path: filePath } = c.req.valid('query');
      const connector = poller.getConnector(c.req.param('id'));
      if (!connector) return notFound(c);

      await connector.deleteFile(filePath, c.req.raw.signal);
      return c.json({ message: 'File deleted successfully', path: filePath });
    });
}
