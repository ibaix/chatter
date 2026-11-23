import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggedInAuth } from '../auth/testSupport.js';
import type { Auth } from '../auth/Auth.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { Focas } from '../machines/fanuc/focas.js';
import { HardwarePoller } from '../polling/poller.js';
import { applySchema } from '../storage/schema.js';
import type { AddMachineRequest } from '../types/index.js';
import { errorOf, testApp } from './testSupport.js';

const HOST = '192.168.1.50';
const NEW_HOST = '192.168.1.99';
const SAVED_PASSWORD = 'saved-secret';
const NEW_PASSWORD = 'new-secret';

interface SavedRow {
  name: string;
  host: string;
  ftp_port: number;
  ftp_user: string;
  ftp_password: string;
  opcua_port?: number;
  opcua_password?: string;
}

// F-10: a saved password must not go to an address that the user typed wrong
describe('PUT /api/machine/:id and the saved passwords', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let cookie: string;
  let db: Database.Database;
  let poller: HardwarePoller;

  beforeAll(async () => {
    ({ auth, accounts, cookie } = await loggedInAuth());
  });

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    poller = new HardwarePoller(db);
    // The FANUC library is not in the repo. These tests never connect, so the library is not loaded.
    vi.spyOn(Focas, 'isAvailable').mockReturnValue(true);
  });

  async function addMachine(request: AddMachineRequest): Promise<string> {
    return (await poller.addMachine(request)).id;
  }

  const update = (id: string, body: object) => testApp({ auth, accounts, poller }).request(`/api/machine/${id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const savedRow = (type: string, id: string) =>
    db.prepare(`SELECT * FROM ${type}_machines WHERE id = ?`).get(id) as SavedRow;

  describe.each(['brother', 'haas', 'mtconnect', 'fanuc'] as const)('a %s machine with a saved FTP password', type => {
    let id: string;

    beforeEach(async () => {
      id = await addMachine({ type, name: 'Mill', host: HOST, ftpPassword: SAVED_PASSWORD });
    });

    it('refuses a new IP address with no password, and saves nothing', async () => {
      const res = await update(id, { name: 'Renamed', host: NEW_HOST });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/^Type the FTP password again/);
      expect(savedRow(type, id)).toMatchObject({ name: 'Mill', host: HOST, ftp_password: SAVED_PASSWORD });
      expect(poller.getConnector(id)).toMatchObject({ name: 'Mill', host: HOST, ftpPassword: SAVED_PASSWORD });
    });
  });

  describe('a Brother machine with a saved FTP password', () => {
    let id: string;

    beforeEach(async () => {
      id = await addMachine({ type: 'brother', name: 'Speedio', host: HOST, ftpPort: 21, ftpPassword: SAVED_PASSWORD });
    });

    // The web form sends each field, also the fields that did not change, and leaves out an empty password box
    const webForm = { name: 'Speedio', host: HOST, dataPort: 10000, ftpPort: 21, ftpUser: 'anonymous', macros: [] };

    it('keeps the password when the address does not change', async () => {
      const res = await update(id, { ...webForm, name: 'Speedio 2' });

      expect(res.status).toBe(200);
      expect(savedRow('brother', id)).toMatchObject({ name: 'Speedio 2', host: HOST, ftp_password: SAVED_PASSWORD });
      expect(poller.getConnector(id)?.ftpPassword).toBe(SAVED_PASSWORD);
    });

    it('keeps the password when only the FTP username changes, because the password goes to the same machine', async () => {
      const res = await update(id, { ...webForm, ftpUser: 'operator' });

      expect(res.status).toBe(200);
      expect(savedRow('brother', id)).toMatchObject({ ftp_user: 'operator', ftp_password: SAVED_PASSWORD });
    });

    it('saves a new IP address with the new password that comes with it', async () => {
      const res = await update(id, { ...webForm, host: NEW_HOST, ftpPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(savedRow('brother', id)).toMatchObject({ host: NEW_HOST, ftp_password: NEW_PASSWORD });
      expect(poller.getConnector(id)).toMatchObject({ host: NEW_HOST, ftpPassword: NEW_PASSWORD });
    });

    it('refuses a new FTP port with no password, and saves nothing', async () => {
      const res = await update(id, { ...webForm, ftpPort: 2121 });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/^Type the FTP password again/);
      expect(savedRow('brother', id)).toMatchObject({ ftp_port: 21, ftp_password: SAVED_PASSWORD });
      expect(poller.getConnector(id)?.ftpPort).toBe(21);
    });

    it('removes the password with a new IP address when the password is empty', async () => {
      const res = await update(id, { ...webForm, host: NEW_HOST, ftpPassword: '' });

      expect(res.status).toBe(200);
      expect(savedRow('brother', id)).toMatchObject({ host: NEW_HOST, ftp_password: '' });
      expect(poller.getConnector(id)?.ftpPassword).toBe('');
    });
  });

  it('changes the IP address and the FTP port of a machine with no saved password', async () => {
    const id = await addMachine({ type: 'brother', name: 'Speedio', host: HOST });

    const res = await update(id, { host: NEW_HOST, ftpPort: 2121 });

    expect(res.status).toBe(200);
    expect(savedRow('brother', id)).toMatchObject({ host: NEW_HOST, ftp_port: 2121, ftp_password: '' });
  });

  describe('a Siemens machine', () => {
    const SINUMERIK = { type: 'siemens', name: 'Sinumerik', host: HOST, opcuaPort: 4840, opcuaUser: 'OpcUaClient' } as const;

    it('refuses a new OPC UA port with no OPC UA password, and saves nothing', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD });

      const res = await update(id, { opcuaPort: 4841 });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/^Type the OPC UA password again/);
      expect(savedRow('siemens', id)).toMatchObject({ opcua_port: 4840, opcua_password: SAVED_PASSWORD });
    });

    it('saves a new OPC UA port with the new OPC UA password', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD });

      const res = await update(id, { opcuaPort: 4841, opcuaPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(savedRow('siemens', id)).toMatchObject({ opcua_port: 4841, opcua_password: NEW_PASSWORD });
    });

    it('changes the FTP port when only the OPC UA password is saved, because that password does not go to the FTP port', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD });

      const res = await update(id, { ftpPort: 2121 });

      expect(res.status).toBe(200);
      expect(savedRow('siemens', id)).toMatchObject({ ftp_port: 2121, opcua_password: SAVED_PASSWORD });
    });

    it('asks for each saved password that a new IP address would move, and saves nothing', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD, ftpPassword: SAVED_PASSWORD });

      const res = await update(id, { host: NEW_HOST, ftpPassword: NEW_PASSWORD });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/^Type the OPC UA password again/);
      expect(savedRow('siemens', id)).toMatchObject({ host: HOST, ftp_password: SAVED_PASSWORD, opcua_password: SAVED_PASSWORD });
    });

    it('asks for the two passwords in one message when both are missing', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD, ftpPassword: SAVED_PASSWORD });

      const res = await update(id, { host: NEW_HOST });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/^Type the FTP password and the OPC UA password again/);
    });

    it('saves a new IP address when each saved password comes again or is removed', async () => {
      const id = await addMachine({ ...SINUMERIK, opcuaPassword: SAVED_PASSWORD, ftpPassword: SAVED_PASSWORD });

      const res = await update(id, { host: NEW_HOST, ftpPassword: '', opcuaPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(savedRow('siemens', id)).toMatchObject({ host: NEW_HOST, ftp_password: '', opcua_password: NEW_PASSWORD });
    });
  });
});
