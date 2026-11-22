import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAccess = vi.fn();
vi.mock('basic-ftp', () => ({
  Client: vi.fn(function () { return { access: mockAccess, list: vi.fn().mockResolvedValue([]), close: vi.fn(), ftp: {} }; }),
}));

import { BrotherConnector } from '../machines/brother/BrotherConnector.js';
import { FanucConnector } from '../machines/fanuc/FanucConnector.js';
import { HaasConnector } from '../machines/haas/HaasConnector.js';
import { MTConnectConnector } from '../machines/mtconnect/MTConnectConnector.js';
import { SiemensConnector } from '../machines/siemens/SiemensConnector.js';
import type { BaseMachineConnector } from '../machines/BaseMachineConnector.js';
import {
  applyBrotherUpdate, applyFanucUpdate, applyHaasUpdate, applyMTConnectUpdate, applySiemensUpdate, newSiemensMachine, toSiemensUpdate,
} from './machineSettings.js';

const HOST = '192.168.1.50';

/** The login that the next FTP transfer uses */
async function ftpLoginOf(connector: BaseMachineConnector) {
  mockAccess.mockClear();
  await connector.listFiles('/');
  const { host, port, user, password } = mockAccess.mock.calls[0][0];
  return { host, port, user, password };
}

const MACHINE_TYPES = [
  { type: 'brother', create: () => new BrotherConnector({ name: 'B', host: HOST }), apply: applyBrotherUpdate },
  { type: 'haas', create: () => new HaasConnector({ name: 'H', host: HOST }), apply: applyHaasUpdate },
  { type: 'mtconnect', create: () => new MTConnectConnector({ name: 'M', host: HOST }), apply: applyMTConnectUpdate },
  { type: 'fanuc', create: () => new FanucConnector({ name: 'F', host: HOST }), apply: applyFanucUpdate },
  { type: 'siemens', create: () => new SiemensConnector({ name: 'S', host: HOST }), apply: applySiemensUpdate },
] as const;

describe.each(MACHINE_TYPES)('an FTP login update of a $type machine', ({ create, apply }) => {
  let connector: BaseMachineConnector;
  const applyUpdate = (updates: object) => (apply as (c: BaseMachineConnector, u: object) => void)(connector, updates);

  beforeEach(() => {
    connector = create();
  });

  it('reaches the FTP client at once, with no restart', async () => {
    applyUpdate({ host: '192.168.1.60', ftpPort: 2121, ftpUser: 'operator', ftpPassword: 'secret' });

    expect(await ftpLoginOf(connector)).toEqual({ host: '192.168.1.60', port: 2121, user: 'operator', password: 'secret' });
  });

  it('keeps the saved password when the update has no password', async () => {
    applyUpdate({ ftpPassword: 'secret' });
    applyUpdate({ name: 'New name' });

    expect((await ftpLoginOf(connector)).password).toBe('secret');
  });

  it('removes the saved password when the update has an empty password', async () => {
    applyUpdate({ ftpPassword: 'secret' });
    applyUpdate({ ftpPassword: '' });

    expect((await ftpLoginOf(connector)).password).toBe('');
  });

  it('uses "anonymous" when the username is made empty', async () => {
    applyUpdate({ ftpUser: '' });

    expect((await ftpLoginOf(connector)).user).toBe('anonymous');
  });

  it('gives only whether a password is saved in the status, never the password', () => {
    expect(connector.getStatus()).toMatchObject({ hasFtpPassword: false });

    applyUpdate({ ftpPassword: 'secret' });
    const status = connector.getStatus();

    expect(status).toMatchObject({ hasFtpPassword: true });
    expect(JSON.stringify(status)).not.toContain('secret');
  });
});

describe('Siemens settings', () => {
  it('fills in the defaults of a new machine: port 4840, anonymous, no security', () => {
    expect(newSiemensMachine({ id: 's1', name: 'S', host: HOST })).toEqual({
      id: 's1', name: 'S', host: HOST, opcuaPort: 4840, opcuaUser: '', opcuaPassword: '', opcuaSecurity: 'none',
      ftpPort: 21, ftpUser: 'anonymous', ftpPassword: '', macros: [],
    });
  });

  it('takes only the Siemens fields of an update, with the user trimmed', () => {
    expect(toSiemensUpdate({ opcuaUser: ' OpcUaClient ', opcuaSecurity: 'signAndEncrypt', focasPort: 8193, dataPort: 1 }))
      .toEqual(expect.objectContaining({ opcuaUser: 'OpcUaClient', opcuaSecurity: 'signAndEncrypt' }));
    expect(toSiemensUpdate({ focasPort: 8193 })).not.toHaveProperty('focasPort', 8193);
  });

  it('keeps the saved OPC UA password when the update has none, and removes it with an empty one', () => {
    const connector = new SiemensConnector({ name: 'S', host: HOST, opcuaUser: 'u', opcuaPassword: 'secret' });
    applySiemensUpdate(connector, { name: 'Renamed' });
    expect(connector.getStatus().hasOpcuaPassword).toBe(true);

    applySiemensUpdate(connector, { opcuaPassword: '' });
    expect(connector.getStatus().hasOpcuaPassword).toBe(false);
  });

  it('applies new OPC UA settings to the connector', () => {
    const connector = new SiemensConnector({ name: 'S', host: HOST });
    applySiemensUpdate(connector, { opcuaPort: 4841, opcuaUser: 'u', opcuaSecurity: 'signAndEncrypt' });
    expect(connector.getStatus()).toMatchObject({ opcuaPort: 4841, opcuaUser: 'u', opcuaSecurity: 'signAndEncrypt' });
  });
});

describe('Brother address update', () => {
  const ATC_REPLY = 'RLOD    ATCTL   00\r\nM02,  1,0,0\r\n\r\n00%';
  const UNKNOWN = (command: string) => `RLOD    ${command.padEnd(8)}08\r\n01%`;

  /** A Brother with a fake connection. `knowsAtc` tells if the control knows ATCTL; it knows no ATCTLD. */
  function brotherThatAnswers(knowsAtc: { value: boolean }) {
    const connector = new BrotherConnector({ name: 'B', host: HOST });
    const connectNow = () => Object.assign(connector, { socket: { destroy: () => {} }, connected: true });
    connectNow();
    vi.spyOn(connector, 'connect').mockImplementation(async () => { connectNow(); });
    const sent = vi.spyOn(connector, 'sendCommand').mockImplementation(async command => {
      if (command === 'ATCTL' && knowsAtc.value) return connector.parseResponse(ATC_REPLY);
      if (command.startsWith('ATCTL')) return connector.parseResponse(UNKNOWN(command));
      return connector.parseResponse(`RLOD    ${command.padEnd(8)}00\r\n\r\n00%`);
    });
    const atcCommandsSent = () => sent.mock.calls.map(([command]) => command).filter(command => command.startsWith('ATCTL'));
    return { connector, atcCommandsSent };
  }

  it.each([
    ['host', { host: '192.168.1.60' }],
    ['data port', { dataPort: 10001 }],
  ])('forgets the control type and the tool table when the %s changes', async (_, update) => {
    const { connector } = brotherThatAnswers({ value: true });
    await connector.poll();
    expect(connector.getStatus().data).toMatchObject({ controlType: 'C00', hasPocketInfo: true });

    applyBrotherUpdate(connector, update);

    expect(connector.getStatus().data).toMatchObject({ controlType: null, hasPocketInfo: false, toolTable: {} });
  });

  it('asks the ATC commands again at the new address, also after the old control knew neither', async () => {
    const knowsAtc = { value: false };
    const { connector, atcCommandsSent } = brotherThatAnswers(knowsAtc);
    await connector.poll();
    expect(atcCommandsSent()).toEqual(['ATCTL', 'ATCTLD']);

    applyBrotherUpdate(connector, { host: '192.168.1.60' });
    knowsAtc.value = true;
    await connector.poll();

    expect(connector.getStatus().data.controlType).toBe('C00');
    expect(atcCommandsSent().filter(command => command === 'ATCTL').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the control type when the update has the same host and port', async () => {
    const { connector } = brotherThatAnswers({ value: true });
    await connector.poll();

    applyBrotherUpdate(connector, { name: 'Renamed', host: HOST, dataPort: connector.dataPort });

    expect(connector.getStatus().data).toMatchObject({ controlType: 'C00', hasPocketInfo: true });
  });
});
