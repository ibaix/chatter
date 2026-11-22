import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { captureLog } from '../logging/testSupport.js';
import type { MachineChangeFeed } from './MachineChangeFeed.js';
import { machineEventRoutes } from './machineEvents.js';

describe('machineEventRoutes', () => {
  it('logs an error of the live events, sends no error text, and closes the stream so the browser connects again', async () => {
    const feed = {
      currentMachines: () => { throw new Error('the machine list is broken'); },
      subscribe: () => () => {},
    } as unknown as MachineChangeFeed;
    const app = new Hono().route('/', machineEventRoutes(feed, () => 'admin'));
    const log = captureLog();

    const res = await app.request('/events');
    // text() ends only when the server closes the stream
    const text = await res.text();
    log.restore();

    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(text).not.toContain('event: error');
    expect(text).not.toContain('the machine list is broken');
    expect(log.lines.filter(line => line.level === 'error')).toHaveLength(1);
    expect(log.text('error')).toContain('the machine list is broken');
    expect(log.text('error')).toContain('path=/events');
  });
});
