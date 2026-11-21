import type { Role } from '@local-chatter/shared';
import { Dialog } from '@toolpath/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMachineAlerts } from '../../api/alerts';
import { fetchAlertRules } from '../../api/alertRules';
import { fetchFileTree, fetchUploadFiles } from '../../api/machineFiles';
import { fetchMachineReport } from '../../api/reports';
import { CurrentUserContext } from '../../components/CurrentUser';
import { testMachine } from '../../test/testMachine';
import type { Machine } from '../../types';
import MachineDetailPage from './MachineDetailPage';

vi.mock('../../api/alerts', () => ({ fetchMachineAlerts: vi.fn() }));
vi.mock('../../api/alertRules', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/alertRules')>()),
  fetchAlertRules: vi.fn(),
}));
vi.mock('../../api/reports', () => ({ fetchMachineReport: vi.fn() }));
vi.mock('../../api/machineFiles', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/machineFiles')>()),
  fetchFileTree: vi.fn(),
  fetchUploadFiles: vi.fn(),
}));
// The chart has its own tests. Here it is only a mark on the page.
vi.mock('./MachineHistoryChart', () => ({ default: () => <section aria-label="History chart" /> }));

/** The address of the page now, so a test can read the tab in it */
let shownAddress = '';
function AddressSpy() {
  const location = useLocation();
  shownAddress = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

function renderPage({ address = '/machine/m1', role = 'admin' as Role, machine = testMachine() }: { address?: string; role?: Role; machine?: Machine } = {}) {
  render(
    <CurrentUserContext.Provider value={{ username: 'sam', role }}>
      <Dialog.Provider>
        <MemoryRouter initialEntries={[address]}>
          <Routes>
            <Route
              path="/machine/:id"
              element={<MachineDetailPage machines={[machine]} isLoaded onRemove={vi.fn()} onUpdate={vi.fn()} />}
            />
          </Routes>
          <AddressSpy />
        </MemoryRouter>
      </Dialog.Provider>
    </CurrentUserContext.Provider>,
  );
}

const SENT_FILES = [
  { id: 1, file_name: 'O1000.nc', created_at: '2026-11-19T09:00:00.000Z', updated_at: '2026-11-19T09:00:00.000Z', event_count: 1, last_path: '/' },
  { id: 2, file_name: 'O2000.nc', created_at: '2026-11-19T10:00:00.000Z', updated_at: '2026-11-19T10:00:00.000Z', event_count: 2, last_path: '/' },
];

const tabNames = () => screen.getAllByRole('tab').map(tab => tab.textContent);
const openPanel = () => screen.getByRole('tabpanel');

describe('MachineDetailPage', () => {
  beforeEach(() => {
    vi.mocked(fetchMachineAlerts).mockReset().mockResolvedValue([]);
    vi.mocked(fetchAlertRules).mockReset().mockResolvedValue([]);
    vi.mocked(fetchMachineReport).mockReset().mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchFileTree).mockReset().mockResolvedValue([]);
    vi.mocked(fetchUploadFiles).mockReset().mockResolvedValue([]);
  });

  describe('the tabs', () => {
    it('puts the tabs directly under the header, and starts with Dashboard, Report and Files', () => {
      renderPage();

      expect(tabNames().slice(0, 3)).toEqual(['Dashboard', 'Report', 'Files']);
      expect(screen.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true');
      // Nothing of the machine values is above the tabs
      const tablist = screen.getByRole('tablist', { name: 'Machine sections' });
      const currentJob = screen.getByRole('region', { name: 'Current job' });
      expect(tablist.compareDocumentPosition(currentJob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the current job, the chart and the alerts in the Dashboard tab', async () => {
      renderPage();

      const panel = openPanel();
      expect(panel).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Dashboard' }).id);
      expect(within(panel).getByRole('region', { name: 'Current job' })).toBeInTheDocument();
      expect(within(panel).getByRole('region', { name: 'History chart' })).toBeInTheDocument();
      expect(within(panel).getByRole('region', { name: 'Alerts' })).toBeInTheDocument();
      expect(within(panel).queryByRole('region', { name: 'Report' })).not.toBeInTheDocument();
    });

    it('shows the report only in the Report tab', () => {
      renderPage();
      expect(screen.queryByRole('region', { name: 'Report' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Report' }));

      expect(within(openPanel()).getByRole('region', { name: 'Report' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Current job' })).not.toBeInTheDocument();
    });

    it('keeps the open tab in the address, so a link or a reload opens the same tab', () => {
      renderPage();

      fireEvent.click(screen.getByRole('tab', { name: 'Report' }));

      expect(shownAddress).toBe('/machine/m1?tab=report');
    });

    it('opens the tab that the address names', () => {
      renderPage({ address: '/machine/m1?tab=report' });

      expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
      expect(within(openPanel()).getByRole('region', { name: 'Report' })).toBeInTheDocument();
    });

    it('opens the Dashboard for an unknown tab name', () => {
      renderPage({ address: '/machine/m1?tab=nonsense' });

      expect(screen.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('the Files tab', () => {
    const openFilesTab = async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
      await waitFor(() => expect(fetchUploadFiles).toHaveBeenCalled());
    };
    const viewSwitch = () => screen.getByRole('group', { name: 'Files to show' });

    it('holds the files on the machine and the upload history, with a switch between them', async () => {
      vi.mocked(fetchUploadFiles).mockResolvedValue(SENT_FILES);
      renderPage();
      await openFilesTab();

      expect(screen.queryByRole('tab', { name: /Upload history/ })).not.toBeInTheDocument();
      const onMachine = within(viewSwitch()).getByRole('button', { name: 'On the machine' });
      const uploads = await within(viewSwitch()).findByRole('button', { name: 'Upload history 2' });
      expect(onMachine).toHaveAttribute('aria-pressed', 'true');
      expect(uploads).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('navigation', { name: 'Folders' })).toBeInTheDocument();

      fireEvent.click(uploads);

      expect(uploads).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Every file sent to Mill 1. Chatter keeps each version.')).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: 'O2000.nc' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Folders' })).not.toBeInTheDocument();
    });

    it('has no count on the Files tab', async () => {
      vi.mocked(fetchUploadFiles).mockResolvedValue(SENT_FILES);
      renderPage();
      await openFilesTab();

      expect(screen.getByRole('tab', { name: 'Files' })).toHaveTextContent(/^Files$/);
    });

    it.each(['On the machine', 'Upload history 0'])('lets an operator send files from the %s view', async view => {
      renderPage({ role: 'operator' });
      await openFilesTab();
      fireEvent.click(within(viewSwitch()).getByRole('button', { name: view }));

      fireEvent.click(screen.getByRole('button', { name: 'Send files' }));

      expect(screen.getByText('Send files to')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Send files' })).toHaveLength(1);
    });

    it('shows no Send files button to a viewer', async () => {
      renderPage({ role: 'viewer' });
      await openFilesTab();

      expect(viewSwitch()).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send files' })).not.toBeInTheDocument();
    });
  });
});
