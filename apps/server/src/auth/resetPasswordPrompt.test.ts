import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runPasswordReset } from './resetPasswordPrompt.js';
import { authParts } from './testSupport.js';

const BROWSER = { userAgent: 'test browser', address: '192.168.1.20' };
const NEW_PASSWORD = 'new-admin-password';

const USERNAME_PROMPT = 'Username of the new Admin: ';
const PASSWORD_PROMPT = 'Password of the new Admin: ';
const AGAIN_PROMPT = 'Type the password again: ';
const PROMOTE_PROMPT = 'type PROMOTE: ';

/** A terminal for the test: the person types an answer after each prompt shows */
function fakeTerminal(isTTY = true) {
  const input = Object.assign(new PassThrough(), { isTTY });
  let text = '';
  let read = 0;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return {
    input,
    output,
    text: () => text,
    /** Wait for the next prompt, then type the answer and Enter */
    async type(prompt: string, answer: string) {
      await vi.waitFor(() => expect(text.indexOf(prompt, read)).toBeGreaterThanOrEqual(0));
      read = text.indexOf(prompt, read) + prompt.length;
      input.write(`${answer}\r`);
    },
  };
}

/** An Admin and an Operator, and the Admin is logged in on one browser */
async function shop() {
  const parts = authParts();
  const adminSession = (await parts.auth.setUp({ username: 'admin', password: 'admin-password' }, BROWSER))!;
  await parts.accounts.add({ username: 'sam', password: 'sam-password', role: 'operator' });
  return { ...parts, adminSession };
}

const roles = (users: ReturnType<typeof authParts>['users']) =>
  users.list().map(({ username, role }) => `${username}: ${role}`);

describe('npm run reset-password', () => {
  it('asks for the username and the password two times, and makes the new Admin', async () => {
    const { users, sessions, auth, adminSession } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'boss');
    await terminal.type(PASSWORD_PROMPT, NEW_PASSWORD);
    await terminal.type(AGAIN_PROMPT, NEW_PASSWORD);

    expect(await done).toBe(true);
    expect(roles(users)).toEqual(['boss: admin', 'sam: operator']);
    expect(auth.sessionOf(adminSession)).toBeNull();
    expect(await auth.logIn({ username: 'boss', password: NEW_PASSWORD }, BROWSER)).not.toBeNull();
    expect(terminal.text()).toContain('boss is the new Admin');
  });

  it('shows the username as the person types it, but never the password', async () => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'boss');
    await vi.waitFor(() => expect(terminal.text()).toContain(`${USERNAME_PROMPT}boss`));
    await terminal.type(PASSWORD_PROMPT, NEW_PASSWORD);
    await terminal.type(AGAIN_PROMPT, NEW_PASSWORD);

    expect(await done).toBe(true);
    expect(terminal.text()).not.toContain(NEW_PASSWORD);
  });

  it('removes the spaces around the username, as the setup does', async () => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, '  boss  ');
    await terminal.type(PASSWORD_PROMPT, NEW_PASSWORD);
    await terminal.type(AGAIN_PROMPT, NEW_PASSWORD);

    expect(await done).toBe(true);
    expect(users.findByName('boss')?.role).toBe('admin');
  });

  it('changes nothing when the two passwords are not the same', async () => {
    const { users, sessions, auth, adminSession } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'boss');
    await terminal.type(PASSWORD_PROMPT, NEW_PASSWORD);
    await terminal.type(AGAIN_PROMPT, 'other-password');

    expect(await done).toBe(false);
    expect(terminal.text()).toContain('The two passwords are not the same. Nothing changed.');
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
    expect(auth.sessionOf(adminSession)).not.toBeNull();
  });

  it('changes nothing when the password is too short, and tells the rule of the setup', async () => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'boss');
    await terminal.type(PASSWORD_PROMPT, 'short');

    expect(await done).toBe(false);
    expect(terminal.text()).toContain('The password must have at least 8 characters. Nothing changed.');
    expect(terminal.text()).not.toContain(AGAIN_PROMPT);
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
  });

  it('changes nothing when the username has a colon, and tells the rule of the setup', async () => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'ops:west');

    expect(await done).toBe(false);
    expect(terminal.text()).toContain('The username cannot have a colon (:) in it. Nothing changed.');
    expect(terminal.text()).not.toContain(PASSWORD_PROMPT);
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
  });

  it('promotes an Operator after the person types PROMOTE', async () => {
    const { users, sessions, auth } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'sam');
    await terminal.type(PROMOTE_PROMPT, 'PROMOTE');
    await terminal.type(PASSWORD_PROMPT, NEW_PASSWORD);
    await terminal.type(AGAIN_PROMPT, NEW_PASSWORD);

    expect(await done).toBe(true);
    expect(terminal.text()).toContain('The user sam exists already, with the role operator.');
    expect(roles(users)).toEqual(['sam: admin']);
    expect(await auth.logIn({ username: 'sam', password: NEW_PASSWORD }, BROWSER)).not.toBeNull();
  });

  it('changes nothing, and asks for no password, when the person does not type PROMOTE', async () => {
    const { users, sessions, auth, adminSession } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'sam');
    await terminal.type(PROMOTE_PROMPT, 'promote');

    expect(await done).toBe(false);
    expect(terminal.text()).toContain('Nothing changed.');
    expect(terminal.text()).not.toContain(PASSWORD_PROMPT);
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
    expect(auth.sessionOf(adminSession)).not.toBeNull();
  });

  it.each([
    ['the person presses Ctrl+C', (input: PassThrough) => input.write('\x03')],
    ['the input ends', (input: PassThrough) => input.end()],
  ])('changes nothing when %s before the last answer', async (_case, stop) => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal();

    const done = runPasswordReset({ ...terminal, users, sessions });
    await terminal.type(USERNAME_PROMPT, 'boss');
    await vi.waitFor(() => expect(terminal.text()).toContain(PASSWORD_PROMPT));
    stop(terminal.input);

    expect(await done).toBe(false);
    expect(terminal.text()).toContain('Nothing changed.');
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
  });

  it('stops with no change when there is no terminal, because it cannot hide the password', async () => {
    const { users, sessions } = await shop();
    const terminal = fakeTerminal(false);

    expect(await runPasswordReset({ ...terminal, users, sessions })).toBe(false);

    expect(terminal.text()).toContain('reset-password needs a terminal');
    expect(terminal.text()).not.toContain(USERNAME_PROMPT);
    expect(roles(users)).toEqual(['admin: admin', 'sam: operator']);
  });
});
