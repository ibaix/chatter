import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from '../auth/Auth.js';
import { SESSION_COOKIE } from '../auth/authRoutes.js';
import { loggedInAuth } from '../auth/testSupport.js';
import type { UserAccounts } from '../auth/userAccounts.js';
import { closeDatabase, getUploadFiles, initDatabase, recordUpload } from '../storage/database.js';
import { testApp, type TestApp } from './testSupport.js';

const PROGRAM_TEXT = 'G00 X0';

// The real upload database, so that a new column in a list query shows here
describe('upload history routes for a Viewer', () => {
  let auth: Auth;
  let accounts: UserAccounts;
  let viewerCookie: string;
  let app: TestApp;

  beforeAll(async () => {
    ({ auth, accounts } = await loggedInAuth());
    const login = { username: 'viewer', password: 'test-password' };
    await accounts.add({ ...login, role: 'viewer' });
    viewerCookie = `${SESSION_COOKIE}=${await auth.logIn(login, { userAgent: 'test browser', address: '127.0.0.1' })}`;
  });

  beforeEach(async () => {
    process.env.DATABASE_PATH = ':memory:';
    await initDatabase();
    await recordUpload('m1', 'part.nc', 'O1000.NC', '/PRG/O1000.NC', PROGRAM_TEXT);
    app = testApp({ auth, accounts });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  const asViewer = (path: string) => app.request(path, { headers: { Cookie: viewerCookie } });

  /** The text, and the stored (gzip) content, are not in the reply */
  function expectNoProgramText(text: string) {
    expect(text).not.toContain(PROGRAM_TEXT);
    expect(text).not.toContain('file_content');
  }

  it('gives the names and dates of the sent files, but not the program text', async () => {
    const res = await asViewer('/api/machine/m1/uploads');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('part.nc');
    expectNoProgramText(text);
  });

  it('gives the versions of a sent file, but not the program text', async () => {
    const [file] = await getUploadFiles('m1');
    const res = await asViewer(`/api/machine/m1/uploads/${file.id}/events`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('/PRG/O1000.NC');
    expectNoProgramText(text);
  });
});
