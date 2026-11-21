import { describe, expect, it } from 'vitest';
import type { LogEntry, LogLevel } from './logger.js';
import { LogBuffer } from './LogBuffer.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, seconds));

function entry(text: string, { level = 'info', machine, time = at(0) }: { level?: LogLevel; machine?: string; time?: Date } = {}): LogEntry {
  return { time, level, component: 'test', machine, text };
}

describe('LogBuffer', () => {
  it('keeps at most the line limit, and drops the oldest lines', () => {
    const buffer = new LogBuffer({ lines: 3, characters: 1000, lineCharacters: 100 });
    for (const text of ['a', 'b', 'c', 'd']) buffer.add(entry(text));
    expect(buffer.lines().map(line => line.text)).toEqual(['b', 'c', 'd']);
  });

  it('keeps at most the character limit', () => {
    const buffer = new LogBuffer({ lines: 100, characters: 10, lineCharacters: 100 });
    for (const text of ['aaaa', 'bbbb', 'cccc']) buffer.add(entry(text));
    expect(buffer.lines().map(line => line.text)).toEqual(['bbbb', 'cccc']);
  });

  it('cuts a line that is too long', () => {
    const buffer = new LogBuffer({ lines: 100, characters: 1000, lineCharacters: 20 });
    buffer.add(entry('x'.repeat(50)));
    const [line] = buffer.lines();
    expect(line.text).toHaveLength(20);
    expect(line.text.endsWith('…[cut]')).toBe(true);
  });

  it('gives the lines of a level and higher, of one machine, from a time', () => {
    const buffer = new LogBuffer();
    buffer.add(entry('debug m1', { level: 'debug', machine: 'm1', time: at(1) }));
    buffer.add(entry('warn m1 old', { level: 'warn', machine: 'm1', time: at(1) }));
    buffer.add(entry('warn m1', { level: 'warn', machine: 'm1', time: at(5) }));
    buffer.add(entry('error m2', { level: 'error', machine: 'm2', time: at(5) }));
    buffer.add(entry('info server', { time: at(6) }));
    expect(buffer.lines({ level: 'warn' }).map(line => line.text)).toEqual(['warn m1 old', 'warn m1', 'error m2']);
    expect(buffer.lines({ machine: 'm1', since: at(2) }).map(line => line.text)).toEqual(['warn m1']);
    expect(buffer.text({ machine: 'm2' })).toBe('error m2\n');
  });

  it('tells each listener the new lines until it stops', () => {
    const buffer = new LogBuffer();
    const heard: string[] = [];
    const stop = buffer.subscribe(line => heard.push(line.text));
    buffer.add(entry('one'));
    stop();
    buffer.add(entry('two'));
    expect(heard).toEqual(['one']);
  });
});
