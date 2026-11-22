import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDownloadUrl,
  cancelRestore,
  confirmRestore,
  prepareBackup,
  uploadRestoreFile,
  type PreparedBackup,
  type RestorePreview,
} from '../../api/historyBackup';
import { testMachine } from '../../test/testMachine';
import { HistoryBackupSection } from './HistoryBackupSection';

vi.mock('../../api/historyBackup', () => ({
  prepareBackup: vi.fn(),
  backupDownloadUrl: vi.fn(),
  uploadRestoreFile: vi.fn(),
  confirmRestore: vi.fn(),
  cancelRestore: vi.fn(),
}));

const PREPARED: PreparedBackup = {
  id: 'b1',
  fileName: 'chatter-history-Speedio-2026-11-21.tar.gz',
  data: { first: 1, last: 2 },
  parts: { 'history/raw.jsonl.gz': { bytes: 2048, sha256: 'a', count: 5 }, 'alert-rules.json': { bytes: 1024, sha256: 'b', count: 1 } },
};

const PREVIEW: RestorePreview = {
  id: 'r1',
  source: { id: 'brother_1', name: 'Old Speedio', type: 'brother' },
  chatterVersion: '1.4.0',
  createdAt: '2026-11-21T10:00:00.000Z',
  range: { from: null, to: 2 },
  data: { first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 10, 1) },
  averagesOnly: false,
  counts: { rawSamples: 12000, averageSamples: 400, periods: 25, alertRules: 3 },
  tooOld: { samples: 0, periods: 0 },
  sameMachine: false,
  targetHasHistory: false,
};

function chooseFile() {
  fireEvent.change(screen.getByLabelText('Backup file to restore'), { target: { files: [new File(['x'], 'backup.tar.gz')] } });
}

describe('HistoryBackupSection', () => {
  const machine = testMachine();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareBackup).mockResolvedValue(PREPARED);
    vi.mocked(backupDownloadUrl).mockReturnValue('/api/machine/m1/history-backup/b1');
    vi.mocked(uploadRestoreFile).mockResolvedValue(PREVIEW);
    vi.mocked(confirmRestore).mockResolvedValue({ samples: 12400, periodsAdded: 20, periodsKnown: 5, alertRules: 3 });
    vi.mocked(cancelRestore).mockResolvedValue();
  });

  it('backs up all the history by default, and starts the download of the file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<HistoryBackupSection machine={machine} canRestore />);

    fireEvent.click(screen.getByRole('button', { name: 'Back up history' }));

    expect(await screen.findByText(/The download of chatter-history-Speedio-2026-11-21.tar.gz \(about 3 KB\) started/)).toBeInTheDocument();
    expect(prepareBackup).toHaveBeenCalledWith(machine.id, { from: null, averagesOnly: false });
    expect(backupDownloadUrl).toHaveBeenCalledWith(machine.id, 'b1');
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  describe('in the time zone of New York', () => {
    let timeZone: string | undefined;
    beforeEach(() => {
      timeZone = process.env.TZ;
      process.env.TZ = 'America/New_York';
    });
    afterEach(() => {
      if (timeZone === undefined) delete process.env.TZ;
      else process.env.TZ = timeZone;
    });

    it('backs up a range of days, from the start of the first day to the end of the last day, with 1-minute averages only', async () => {
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<HistoryBackupSection machine={machine} canRestore />);

      fireEvent.change(screen.getByLabelText('From (empty: all the history)'), { target: { value: '2026-11-01' } });
      fireEvent.change(screen.getByLabelText('To (empty: now)'), { target: { value: '2026-11-02' } });
      fireEvent.click(screen.getByRole('checkbox', { name: /1-minute averages only/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Back up history' }));

      // 1 November 2026 is the last day of summer time in New York
      await waitFor(() => expect(prepareBackup).toHaveBeenCalledWith(machine.id, {
        from: Date.UTC(2026, 10, 1, 4), to: Date.UTC(2026, 10, 3, 5), averagesOnly: true,
      }));
    });

    it('ends a day of 23 hours at its true end, on the first day of summer time', async () => {
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<HistoryBackupSection machine={machine} canRestore />);

      fireEvent.change(screen.getByLabelText('From (empty: all the history)'), { target: { value: '2026-03-08' } });
      fireEvent.change(screen.getByLabelText('To (empty: now)'), { target: { value: '2026-03-08' } });
      fireEvent.click(screen.getByRole('button', { name: 'Back up history' }));

      await waitFor(() => expect(prepareBackup).toHaveBeenCalledWith(machine.id, {
        from: Date.UTC(2026, 2, 8, 5), to: Date.UTC(2026, 2, 9, 4), averagesOnly: false,
      }));
    });
  });

  it('shows the reason when the server refuses the backup', async () => {
    vi.mocked(prepareBackup).mockRejectedValue(new Error('A history restore runs now.'));
    render(<HistoryBackupSection machine={machine} canRestore />);
    fireEvent.click(screen.getByRole('button', { name: 'Back up history' }));
    expect(await screen.findByText('A history restore runs now.')).toBeInTheDocument();
  });

  it('shows a preview of the file, and restores with the alert rules by default', async () => {
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();

    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    expect(preview).toHaveTextContent('Old Speedio (brother)');
    expect(preview).toHaveTextContent((12000).toLocaleString());
    expect(preview).toHaveTextContent('25');
    expect(screen.getByRole('checkbox', { name: /Also restore the alert rules/ })).toBeChecked();
    expect(confirmRestore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: `Restore into ${machine.name}` }));

    expect(await screen.findByText(/The history is restored: .* \(5 were there already\)\. The alert rules of the file \(3\) replace/)).toBeInTheDocument();
    expect(confirmRestore).toHaveBeenCalledWith(machine.id, 'r1', true);
    expect(screen.queryByRole('region', { name: 'Restore preview' })).toBeNull();
  });

  it('shows the reason when the restore fails, and keeps the preview for another try', async () => {
    vi.mocked(confirmRestore).mockRejectedValueOnce(new Error('The history database (VictoriaMetrics) does not answer now. Try again later.'));
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: `Restore into ${machine.name}` }));

    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    expect(await within(preview).findByText(/does not answer now/)).toBeInTheDocument();
    expect(screen.queryByText(/The history is restored/)).toBeNull();

    fireEvent.click(within(preview).getByRole('button', { name: `Restore into ${machine.name}` }));
    expect(await screen.findByText(/The history is restored/)).toBeInTheDocument();
    expect(confirmRestore).toHaveBeenCalledTimes(2);
  });

  it('warns when the machine has history in the time of the file already', async () => {
    vi.mocked(uploadRestoreFile).mockResolvedValue({ ...PREVIEW, targetHasHistory: true });
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    expect(await screen.findByText('This machine has history in the time of the file')).toBeInTheDocument();
    expect(screen.getByText(/You cannot undo a restore/)).toBeInTheDocument();
  });

  it('does not warn when the machine has no history in the time of the file, or when the file is from this machine', async () => {
    vi.mocked(uploadRestoreFile).mockResolvedValue({ ...PREVIEW, targetHasHistory: true, sameMachine: true });
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    await screen.findByRole('region', { name: 'Restore preview' });
    expect(screen.queryByText('This machine has history in the time of the file')).toBeNull();
  });

  it('keeps the alert rules of the machine when the user clears the box', async () => {
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Also restore the alert rules/ }));
    fireEvent.click(screen.getByRole('button', { name: `Restore into ${machine.name}` }));
    await waitFor(() => expect(confirmRestore).toHaveBeenCalledWith(machine.id, 'r1', false));
  });

  it('tells how much history is too old to restore', async () => {
    vi.mocked(uploadRestoreFile).mockResolvedValue({ ...PREVIEW, tooOld: { samples: 500, periods: 2 } });
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    expect(await screen.findByText('Some of the history is older than 1 year')).toBeInTheDocument();
  });

  it('deletes the file on the server when the user cancels', async () => {
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancelRestore).toHaveBeenCalledWith(machine.id, 'r1');
    expect(screen.queryByRole('region', { name: 'Restore preview' })).toBeNull();
  });

  it('shows the reason when the server refuses the file', async () => {
    vi.mocked(uploadRestoreFile).mockRejectedValue(new Error('The file is from a machine of the type haas.'));
    render(<HistoryBackupSection machine={machine} canRestore />);
    chooseFile();
    expect(await screen.findByText('The file is from a machine of the type haas.')).toBeInTheDocument();
  });

  it('has no restore for a user who is not an admin', () => {
    render(<HistoryBackupSection machine={machine} canRestore={false} />);
    expect(screen.getByRole('button', { name: 'Back up history' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore history' })).toBeNull();
  });
});
