import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';
import { captureLog, type CapturedLog } from '../logging/testSupport.js';
import { errorReply, machineErrorReply, UNEXPECTED_ERROR_TEXT } from './responses.js';

/** A small app whose one route throws `error` */
function appThatThrows(error: Error, onError = errorReply) {
  return new Hono()
    .onError(onError)
    .post('/fail', () => { throw error; });
}

const post = (app: Hono, body?: string) =>
  app.request('/fail?secret=x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

describe('errorReply', () => {
  let log: CapturedLog;
  beforeEach(() => { log = captureLog(); });
  afterEach(() => log.restore());

  it('gives a general text for an unexpected error, and logs the error with its stack, the method and the path', async () => {
    const res = await post(appThatThrows(new Error('SQLITE_CORRUPT at /app/data/chatter.db')));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: UNEXPECTED_ERROR_TEXT });
    const errors = log.text('error');
    expect(errors).toContain('SQLITE_CORRUPT at /app/data/chatter.db');
    expect(errors).toContain('method=POST');
    expect(errors).toContain('path=/fail');
    // The stack shows where the error came from
    expect(errors).toMatch(/\n\s+at /);
    // The query can hold names and values that the log does not need
    expect(errors).not.toContain('secret');
  });

  it('keeps the status and the text of an HTTPException, and logs nothing', async () => {
    const res = await post(appThatThrows(new HTTPException(403, { message: 'Not for you' })));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not for you' });
    expect(log.lines).toEqual([]);
  });

  it('keeps the 400 of a body that is not JSON, and logs nothing', async () => {
    const app = new Hono()
      .onError(errorReply)
      .post('/fail', validator('json', value => value), c => c.json({}));

    const res = await post(app, '{not json');

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('Malformed JSON');
    expect(log.lines).toEqual([]);
  });
});

describe('machineErrorReply', () => {
  let log: CapturedLog;
  beforeEach(() => { log = captureLog(); });
  afterEach(() => log.restore());

  it('keeps the text of the machine, because it tells the user what the machine refused, and logs the error', async () => {
    const res = await post(appThatThrows(new Error('FTP download error: 550'), machineErrorReply));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'FTP download error: 550' });
    expect(log.text('error')).toContain('FTP download error: 550');
    expect(log.text('error')).toContain('path=/fail');
  });

  it('keeps the status and the text of an HTTPException, and logs nothing', async () => {
    const res = await post(appThatThrows(new HTTPException(400, { message: 'Bad path' }), machineErrorReply));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad path' });
    expect(log.lines).toEqual([]);
  });
});
