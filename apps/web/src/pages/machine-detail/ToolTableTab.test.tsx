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

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function renderTab(toolSync: ToolSyncState | undefined, toolTable: ToolTable = TOOLS) {
  return render(<ToolTableTab machineId="m1" toolTable={toolTable} hasPocketInfo spindleTool={undefined} toolSync={toolSync} />);
}

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

    expect(screen.getByText(`Synced ${timeOf(SYNCED_AT)}`)).toBeInTheDocument();
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
    finish(SYNCED);
    await waitFor(() => expect(screen.getByText(`Synced ${timeOf(SYNCED_AT)}`)).toBeInTheDocument());
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
    expect(screen.getByText(`Synced ${timeOf(SYNCED_AT)}`)).toBeInTheDocument();
  });

  it('has no Sync for a machine that sends its tool table in each poll', () => {
    renderTab(undefined);

    expect(screen.queryByRole('button', { name: 'Sync' })).not.toBeInTheDocument();
  });
});
