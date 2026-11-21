import type { AlertRule, Role } from '@local-chatter/shared';
import { Dialog } from '@toolpath/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMachineAlerts, type MachineAlert } from '../../api/alerts';
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

const OFFLINE_RULE: AlertRule = {
  id: 'r1', kind: 'simple', enabled: true, subject: 'not-connected', check: 'above', limit: 0, forMinutes: 10, severity: 'warning',
};

function firingAlert(name: string): MachineAlert {
  return { name, machineId: 'm1', labels: { severity: 'critical' }, annotations: {}, start: '2026-11-20T09:00:00.000Z', end: null, firing: true };
}

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

  describe('the Settings tab', () => {
    const toolMachine = () => testMachine({}, { toolTable: { 1: { toolNum: 1 }, 2: { toolNum: 2 } } });

    it('is the last tab, after the tool table, for each role', () => {
      for (const role of ['admin', 'operator', 'viewer'] as const) {
        renderPage({ role, machine: toolMachine() });
        expect(tabNames()).toEqual(['Dashboard', 'Report', 'Files', 'Tool table2', 'Settings']);
        cleanup();
      }
    });

    it('shows an admin the machine settings and the alert rules, with a menu to jump to each', async () => {
      vi.mocked(fetchAlertRules).mockResolvedValue([OFFLINE_RULE]);
      renderPage();

      fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

      const machineSection = screen.getByRole('region', { name: 'Machine' });
      expect(within(machineSection).getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
      const rulesSection = screen.getByRole('region', { name: 'Alert rules' });
      expect(await within(rulesSection).findByText(/Click a word in a rule to change it/)).toBeInTheDocument();
      const menu = screen.getByRole('navigation', { name: 'Settings sections' });
      expect(within(menu).getByRole('link', { name: 'Machine' })).toHaveAttribute('href', `#${machineSection.id}`);
      expect(within(menu).getByRole('link', { name: 'Alert rules 1' })).toHaveAttribute('href', `#${rulesSection.id}`);
    });

    it('shows a viewer only the alert rules, and they cannot change them', async () => {
      renderPage({ role: 'viewer' });

      fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

      const rulesSection = screen.getByRole('region', { name: 'Alert rules' });
      expect(await within(rulesSection).findByText(/Only an admin can change them/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Machine' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument();
    });
  });

  describe('the link from the alerts to the rules', () => {
    const scrolledTo: Element[] = [];
    beforeEach(() => {
      scrolledTo.length = 0;
      // jsdom does not scroll
      Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
        scrolledTo.push(this);
      };
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it('opens Settings at the alert rules', async () => {
      renderPage();

      fireEvent.click(await screen.findByRole('link', { name: 'Settings › Alert rules' }));

      expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
      const rulesSection = screen.getByRole('region', { name: 'Alert rules' });
      expect(shownAddress).toBe(`/machine/m1?tab=settings#${rulesSection.id}`);
      await waitFor(() => expect(scrolledTo).toContain(rulesSection));
    });

    it('scrolls to the alert rules again when they load, because the page is longer then', async () => {
      let loadRules: (rules: AlertRule[]) => void = () => {};
      vi.mocked(fetchAlertRules).mockReturnValue(new Promise(resolve => { loadRules = resolve; }));
      renderPage({ address: '/machine/m1?tab=settings#settings-alert-rules' });
      const rulesSection = screen.getByRole('region', { name: 'Alert rules' });
      await waitFor(() => expect(scrolledTo).toEqual([rulesSection]));

      loadRules([OFFLINE_RULE]);

      await screen.findByText(/Click a word in a rule to change it/);
      expect(scrolledTo).toEqual([rulesSection, rulesSection]);
    });
  });

  describe('the firing alerts', () => {
    const header = () => screen.getByRole('heading', { level: 1, name: 'Mill 1' }).parentElement as HTMLElement;

    it('shows a badge next to the machine name and a count on the Dashboard tab, from one load of the alerts', async () => {
      vi.mocked(fetchMachineAlerts).mockResolvedValue([firingAlert('Spindle load'), firingAlert('Offline')]);
      renderPage();

      expect(await within(header()).findByRole('link', { name: '2 alerts firing' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Dashboard 2 alerts firing' })).toBeInTheDocument();
      expect(screen.getByText('2 firing now')).toBeInTheDocument();
      expect(fetchMachineAlerts).toHaveBeenCalledTimes(1);
    });

    it('says "1 alert firing" for one alert', async () => {
      vi.mocked(fetchMachineAlerts).mockResolvedValue([firingAlert('Offline')]);
      renderPage();

      expect(await within(header()).findByRole('link', { name: '1 alert firing' })).toBeInTheDocument();
    });

    it('opens the Dashboard tab from the badge', async () => {
      vi.mocked(fetchMachineAlerts).mockResolvedValue([firingAlert('Offline')]);
      renderPage({ address: '/machine/m1?tab=report' });

      fireEvent.click(await screen.findByRole('link', { name: '1 alert firing' }));

      expect(screen.getByRole('tab', { name: /^Dashboard/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('region', { name: 'Alerts' })).toBeInTheDocument();
    });

    it('shows no badge and no count when no alert fires', async () => {
      vi.mocked(fetchMachineAlerts).mockResolvedValue([{ ...firingAlert('Offline'), firing: false, end: '2026-11-20T09:05:00.000Z' }]);
      renderPage();

      await screen.findByText('Offline');
      expect(screen.queryByRole('link', { name: /firing/ })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Dashboard' })).toBeInTheDocument();
    });
  });
});
