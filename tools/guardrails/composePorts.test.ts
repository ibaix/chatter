import { describe, expect, it } from 'vitest';
import { portsOpened } from './composePorts';

describe('portsOpened', () => {
  it.each([
    ['3001', { hostIp: '', containerPorts: [3001] }],
    ['3001:3001', { hostIp: '', containerPorts: [3001] }],
    ['8080:3001', { hostIp: '', containerPorts: [3001] }],
    ['127.0.0.1:8428:8428', { hostIp: '127.0.0.1', containerPorts: [8428] }],
    ['127.0.0.1::8880', { hostIp: '127.0.0.1', containerPorts: [8880] }],
    ['[::1]:3002:3002', { hostIp: '::1', containerPorts: [3002] }],
    ['8000-8002:8000-8002', { hostIp: '', containerPorts: [8000, 8001, 8002] }],
    ['3002:3002/udp', { hostIp: '', containerPorts: [3002] }],
  ])('reads the short form %s', (entry, opened) => {
    expect(portsOpened(entry)).toEqual(opened);
  });

  it('reads a number', () => {
    expect(portsOpened(8428)).toEqual({ hostIp: '', containerPorts: [8428] });
  });

  it('reads the long form, also with no published port (Docker then picks a host port)', () => {
    expect(portsOpened({ target: 8428 })).toEqual({ hostIp: '', containerPorts: [8428] });
    expect(portsOpened({ target: 3002, published: '3002', host_ip: '127.0.0.1' })).toEqual({ hostIp: '127.0.0.1', containerPorts: [3002] });
    expect(portsOpened({ target: '8000-8001', published: '9000-9001' })).toEqual({ hostIp: '', containerPorts: [8000, 8001] });
  });
});
