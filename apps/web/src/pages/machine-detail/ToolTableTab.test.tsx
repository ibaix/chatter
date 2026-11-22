import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSyncState, ToolTable } from '../../types';
import { ToolTableTab } from './ToolTableTab';

const syncTools = vi.fn<(machineId: string) => Promise<ToolSyncState>>();
vi.mock('../../api/toolSync', () => ({ syncTools: (machineId: string) => syncTools(machineId) }));

const SYNCED_AT = '2026-11-21T08:05:00.000Z';
const NOT_SYNCED: ToolSyncState = { lastSyncAt: null, lastAttemptAt: null, error: null, running: false };
const SYNCED: ToolSyncState = { lastSyncAt: SYNCED_AT, lastAttemptAt: SYNCED_AT, error: null, running: false };
const TOOLS = { 1: { toolNum: 5, length: 3.402, name: 'ENDMILL' } };

/** The text for SYNCED_AT. vitest.config.js sets the time zone (UTC) and the locale (en-US) of the tests. */
const SYNCED_TEXT = 'Synced 08:05 AM';

function renderTab(toolSync: ToolSyncState | undefined, toolTable: ToolTable = TOOLS) {
  return render(<ToolTableTab machineId="m1" toolTable={toolTable} hasPocketInfo spindleTool={undefined} toolSync={toolSync} />);
}

/** A state of the server at `iso`: the time of the last read and of the last try */
const syncedAt = (iso: string, error: string | null = null): ToolSyncState =>
  ({ lastSyncAt: error ? SYNCED_AT : iso, lastAttemptAt: iso, error, running: false });

describe('ToolTableTab sync', () => {
  beforeEach(() => {
    syncTools.mockReset();
  });

  it('says "Not synced yet" and offers Sync before the first read', () => {
    renderTab(NOT_SYNCED, {});

    expect(screen.getByText('Not synced yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeEnabled();
  });

  it('gives the time of the last good read', () => {
    renderTab(SYNCED);

    expect(screen.getByText(SYNCED_TEXT)).toBeInTheDocument();
    expect(screen.getByText('ENDMILL')).toBeInTheDocument();
  });

  it('says "Syncing…" while the server reads the tools', () => {
    renderTab({ ...SYNCED, running: true });

    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
  });

  it('reads the tools when the user presses Sync, and shows "Syncing…" until the read ends', async () => {
    let finish: (state: ToolSyncState) => void = () => {};
    syncTools.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderTab(NOT_SYNCED, {});

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    expect(syncTools).toHaveBeenCalledWith('m1');
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
    finish(SYNCED);
    await waitFor(() => expect(screen.getByText(SYNCED_TEXT)).toBeInTheDocument());
  });

  it('shows the error of a Sync that fails, and keeps the button', async () => {
    syncTools.mockRejectedValue(new Error('Chatter read the tool table a short time ago. Try again in 20 seconds.'));
    renderTab(SYNCED);

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 20 seconds');
    expect(screen.getByRole('button', { name: 'Sync' })).toBeEnabled();
  });

  it('shows the error of the last automatic read', () => {
    renderTab({ ...SYNCED, error: 'No reply' });

    expect(screen.getByRole('alert')).toHaveTextContent('No reply');
    expect(screen.getByText(SYNCED_TEXT)).toBeInTheDocument();
  });

  it('shows a later status of the server with an error, not the older result of the Sync', async () => {
    syncTools.mockResolvedValue(syncedAt('2026-11-21T08:10:00.000Z'));
    const { rerender } = renderTab(SYNCED);
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Synced 08:10 AM')).toBeInTheDocument();

    rerender(<ToolTableTab machineId="m1" toolTable={TOOLS} hasPocketInfo spindleTool={undefined} toolSync={syncedAt('2026-11-21T08:30:00.000Z', 'No reply')} />);

    expect(screen.getByRole('alert')).toHaveTextContent('No reply');
    expect(screen.getByText(SYNCED_TEXT)).toBeInTheDocument();
  });

  it('keeps the result of the Sync when an older status of the server comes', async () => {
    syncTools.mockResolvedValue(syncedAt('2026-11-21T08:10:00.000Z'));
    const { rerender } = renderTab(SYNCED);
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Synced 08:10 AM')).toBeInTheDocument();

    rerender(<ToolTableTab machineId="m1" toolTable={TOOLS} hasPocketInfo spindleTool={undefined} toolSync={syncedAt(SYNCED_AT, 'No reply')} />);

    expect(screen.getByText('Synced 08:10 AM')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('has no Sync for a machine that sends its tool table in each poll', () => {
    renderTab(undefined);

    expect(screen.queryByRole('button', { name: 'Sync' })).not.toBeInTheDocument();
  });
});
