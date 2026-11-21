import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMachineAlerts, type MachineAlert } from '../../api/alerts';
import { AlertsPanel } from './AlertsPanel';

vi.mock('../../api/alerts', () => ({ fetchMachineAlerts: vi.fn() }));

function alert(values: Partial<MachineAlert>): MachineAlert {
  return {
    name: 'In alarm', machineId: 'haas-vf2', labels: { severity: 'critical' }, annotations: {},
    start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T09:05:00.000Z', firing: false, ...values,
  };
}

/** Past alerts, the newest first */
const pastAlerts = (count: number) =>
  Array.from({ length: count }, (_, index) => alert({ name: `Past ${count - index}`, start: new Date(Date.UTC(2026, 10, 20, 9, count - index)).toISOString() }));

const firingAlerts = (count: number) =>
  Array.from({ length: count }, (_, index) => alert({ name: `Firing ${index + 1}`, end: null, firing: true, start: new Date(Date.UTC(2026, 10, 20, 10, index)).toISOString() }));

async function renderPanel(alerts: MachineAlert[]) {
  vi.mocked(fetchMachineAlerts).mockResolvedValue(alerts);
  // The empty list links to the alert rules in Settings
  render(<AlertsPanel machineId="haas-vf2" />, { wrapper: MemoryRouter });
  await waitFor(() => expect(fetchMachineAlerts).toHaveBeenCalled());
  if (alerts.length > 0) await screen.findByText(alerts[0].name);
}

const alertRows = () => within(screen.getByRole('region', { name: 'Alerts' })).getAllByRole('row').slice(1);

describe('AlertsPanel', () => {
  afterEach(() => {
    vi.mocked(fetchMachineAlerts).mockReset();
  });

  describe('a long alert list', () => {
    it('shows each firing alert, and the newest 10 past alerts with a button for more', async () => {
      await renderPanel([...firingAlerts(3), ...pastAlerts(25)]);

      expect(alertRows()).toHaveLength(13);
      expect(alertRows()[0]).toHaveTextContent('Firing 1');
      expect(alertRows()[3]).toHaveTextContent('Past 25');
      expect(screen.getByText('Showing 10 of 25 past alerts.')).toBeInTheDocument();
    });

    it('shows 10 more past alerts each time the user clicks Show more, and then no button', async () => {
      await renderPanel([...firingAlerts(2), ...pastAlerts(25)]);

      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(alertRows()).toHaveLength(22);

      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(alertRows()).toHaveLength(27);
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    });

    it('shows no button when all the past alerts fit', async () => {
      await renderPanel([...firingAlerts(12), ...pastAlerts(10)]);

      expect(alertRows()).toHaveLength(22);
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    });
  });

  describe('new alerts', () => {
    let visibility: DocumentVisibilityState = 'visible';

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      visibility = 'visible';
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('loads the alerts again every 30 seconds', async () => {
      await renderPanel([]);
      vi.mocked(fetchMachineAlerts).mockResolvedValue(firingAlerts(1));

      await vi.advanceTimersByTimeAsync(30_000);

      expect(await screen.findByText('Firing 1')).toBeInTheDocument();
      expect(fetchMachineAlerts).toHaveBeenCalledTimes(2);
    });

    it('does not load while the page is hidden, and loads at once when the page shows again', async () => {
      await renderPanel([]);
      visibility = 'hidden';

      await vi.advanceTimersByTimeAsync(90_000);
      expect(fetchMachineAlerts).toHaveBeenCalledTimes(1);

      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(fetchMachineAlerts).toHaveBeenCalledTimes(2));
    });

    it('keeps the list when a load fails, and tells the user', async () => {
      await renderPanel(pastAlerts(1));
      vi.mocked(fetchMachineAlerts).mockRejectedValue(new Error('offline'));

      await vi.advanceTimersByTimeAsync(30_000);

      expect(await screen.findByText(/Could not load the alerts/)).toBeInTheDocument();
      expect(screen.getByText('Past 1')).toBeInTheDocument();
    });

    it('stops loading when the user leaves the page', async () => {
      await renderPanel([]);
      cleanup();

      await vi.advanceTimersByTimeAsync(90_000);

      expect(fetchMachineAlerts).toHaveBeenCalledTimes(1);
    });
  });
});
