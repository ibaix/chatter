import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLoginsReport, unlockComputer, unlockUser, type LoginsReport } from '../../api/settings';
import { LoginsTab } from './LoginsTab';

vi.mock('../../api/settings', () => ({ fetchLoginsReport: vi.fn(), unlockComputer: vi.fn(), unlockUser: vi.fn() }));

const ATTACKER = '192.168.1.66';
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000 - 1000).toISOString();

function report(changes: Partial<LoginsReport> = {}): LoginsReport {
  const at = new Date().toISOString();
  return {
    limits: { maxWrongPasswords: 10, maxWrongPasswordsForUser: 30, lockMinutes: 15 },
    locked: [{ address: ATTACKER, username: 'sam', until: inMinutes(14) }],
    lockedUsers: [],
    tries: [
      { at, username: 'sam', address: ATTACKER, result: 'locked' },
      { at, username: 'admin', address: '192.168.1.20', result: 'logged-in' },
    ],
    ...changes,
  };
}

async function renderTab(loaded: LoginsReport) {
  vi.mocked(fetchLoginsReport).mockResolvedValue(loaded);
  render(<LoginsTab />);
  await screen.findByText('Recent logins');
}

describe('LoginsTab', () => {
  beforeEach(() => {
    vi.mocked(unlockComputer).mockReset();
    vi.mocked(unlockUser).mockReset();
  });

  it('shows a locked computer with the user it tried and the time left', async () => {
    await renderTab(report());
    expect(screen.getByText('Tried user "sam" · locked for 14 min more')).toBeInTheDocument();
  });

  it('shows each try with its result', async () => {
    await renderTab(report());
    const rows = within(screen.getByRole('table')).getAllByRole('row');

    expect(rows[1]).toHaveTextContent('Locked: too many wrong passwords');
    expect(rows[2]).toHaveTextContent('admin');
    expect(rows[2]).toHaveTextContent('Logged in');
  });

  it('unlocks a computer', async () => {
    await renderTab(report());
    vi.mocked(unlockComputer).mockResolvedValue(report({ locked: [] }));

    fireEvent.click(screen.getByRole('button', { name: `Unlock ${ATTACKER}` }));

    expect(unlockComputer).toHaveBeenCalledWith(ATTACKER);
    expect(await screen.findByText('No computer is locked.')).toBeInTheDocument();
  });

  it('shows each user that a computer is locked for', async () => {
    const locked = [
      { address: ATTACKER, username: 'sam', until: inMinutes(14) },
      { address: ATTACKER, username: 'admin', until: inMinutes(10) },
    ];
    // React warns on the console when two rows have the same key
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderTab(report({ locked }));

    expect(screen.getByText('Tried user "sam" · locked for 14 min more')).toBeInTheDocument();
    expect(screen.getByText('Tried user "admin" · locked for 10 min more')).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('tells the limits of a computer and of a user', async () => {
    await renderTab(report());
    expect(screen.getByText(
      'After 10 wrong passwords for one user, a computer must wait 15 min to try that user again. You can unlock it now.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'After 30 wrong passwords for one user from all computers, nobody can log in as that user for 15 min. You can unlock the user now.',
    )).toBeInTheDocument();
  });

  it('shows a user that is locked on all computers, and unlocks it', async () => {
    await renderTab(report({ lockedUsers: [{ username: 'admin', until: inMinutes(12) }] }));
    expect(screen.getByText('Locked on all computers for 12 min more')).toBeInTheDocument();
    vi.mocked(unlockUser).mockResolvedValue(report({ lockedUsers: [] }));

    fireEvent.click(screen.getByRole('button', { name: 'Unlock user admin' }));

    expect(unlockUser).toHaveBeenCalledWith('admin');
    expect(await screen.findByText('No user is locked.')).toBeInTheDocument();
  });

  it('shows the reason when the unlock fails', async () => {
    await renderTab(report());
    vi.mocked(unlockComputer).mockRejectedValue(new Error(`Could not unlock ${ATTACKER}`));

    fireEvent.click(screen.getByRole('button', { name: `Unlock ${ATTACKER}` }));

    expect(await screen.findByText(`Could not unlock ${ATTACKER}`)).toBeInTheDocument();
  });

  it('shows the reason when the unlock of a user fails', async () => {
    await renderTab(report({ lockedUsers: [{ username: 'admin', until: inMinutes(12) }] }));
    vi.mocked(unlockUser).mockRejectedValue(new Error('Could not unlock the user admin'));

    fireEvent.click(screen.getByRole('button', { name: 'Unlock user admin' }));

    expect(await screen.findByText('Could not unlock the user admin')).toBeInTheDocument();
  });

  it('turns off each Unlock button while an unlock runs, so a second click cannot send it again', async () => {
    await renderTab(report({ lockedUsers: [{ username: 'admin', until: inMinutes(12) }] }));
    let finish: (loaded: LoginsReport) => void = () => {};
    vi.mocked(unlockUser).mockReturnValue(new Promise(resolve => {
      finish = resolve;
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Unlock user admin' }));

    expect(await screen.findByRole('button', { name: 'Unlock user admin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Unlock ${ATTACKER}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock user admin' }));
    expect(unlockUser).toHaveBeenCalledTimes(1);
    finish(report({ lockedUsers: [] }));
    expect(await screen.findByRole('button', { name: `Unlock ${ATTACKER}` })).toBeEnabled();
  });

  it('loads the list again on Refresh', async () => {
    await renderTab(report({ tries: [] }));
    expect(screen.getByText('No one has tried to log in yet.')).toBeInTheDocument();
    vi.mocked(fetchLoginsReport).mockResolvedValue(report());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Locked: too many wrong passwords')).toBeInTheDocument();
  });

  it('shows the reason when the list cannot load', async () => {
    vi.mocked(fetchLoginsReport).mockRejectedValue(new Error('Could not load the logins'));
    render(<LoginsTab />);
    expect(await screen.findByText('Could not load the logins')).toBeInTheDocument();
  });
});
