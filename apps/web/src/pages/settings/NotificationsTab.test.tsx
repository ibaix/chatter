import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addChannel, fetchChannels, fetchChannelTypes, fetchMessages, fetchNotificationSettings, removeChannel, saveNotificationSettings, sendTestMessage, updateChannel,
  type ChannelTypeInfo, type NotificationChannel, type NotificationMessage,
} from '../../api/notifications';
import { NotificationsTab } from './NotificationsTab';

vi.mock('../../api/notifications', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/notifications')>()),
  fetchChannelTypes: vi.fn(),
  fetchChannels: vi.fn(),
  fetchMessages: vi.fn(),
  fetchNotificationSettings: vi.fn(),
  saveNotificationSettings: vi.fn(),
  sendTestMessage: vi.fn(),
  updateChannel: vi.fn(),
  addChannel: vi.fn(),
  removeChannel: vi.fn(),
}));

const TYPES: ChannelTypeInfo[] = [
  {
    id: 'twilio-sms', name: 'Text message (Twilio)', fields: [
      { key: 'accountSid', label: 'Account SID', kind: 'text', required: true },
      { key: 'authToken', label: 'Auth token', kind: 'secret', required: true },
      { key: 'from', label: 'From number', kind: 'text', required: true },
      { key: 'to', label: 'Phone numbers', kind: 'phone-list', required: true },
    ],
  },
  { id: 'webhook', name: 'Webhook', fields: [{ key: 'url', label: 'Web address', kind: 'url', required: true }] },
];

const phones: NotificationChannel = {
  id: 'phones', type: 'twilio-sms', name: 'Shop phones',
  settings: { accountSid: 'AC1', from: '+15551230000', to: ['+15559870001', '+15559870002'] },
  hasSecret: { authToken: true }, minSeverity: 'critical', machineIds: null, ignorePatterns: ['Door open'], enabled: true, createdAt: '2026-11-13T09:00:00.000Z',
};

const slack: NotificationChannel = {
  ...phones, id: 'slack', type: 'webhook', name: 'Slack #shop-floor', settings: { url: 'https://hooks.slack.com/x' },
  hasSecret: {}, minSeverity: 'warning', machineIds: ['haas-vf2'],
};

function message(values: Partial<NotificationMessage>): NotificationMessage {
  return {
    id: 1, channelId: 'phones', alertId: 7, kind: 'started', machineId: 'haas-vf2', severity: 'critical',
    text: 'CRITICAL - Haas VF-2: In alarm. Started 9:02 AM.', status: 'sent', attempts: 1, lastError: null,
    detail: 'Sent to 2 phones', createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), ...values,
  };
}

const MACHINES = [{ id: 'haas-vf2', name: 'Haas VF-2' }];

async function renderTab(messages: NotificationMessage[] = []) {
  vi.mocked(fetchChannelTypes).mockResolvedValue(TYPES);
  vi.mocked(fetchChannels).mockResolvedValue([phones, slack]);
  vi.mocked(fetchMessages).mockResolvedValue(messages);
  render(<NotificationsTab machines={MACHINES} />);
  await screen.findByRole('region', { name: 'Channels' });
}

function channelRow(name: string): HTMLElement {
  return within(screen.getByRole('region', { name: 'Channels' })).getByText(name).closest('tr') as HTMLElement;
}

describe('NotificationsTab', () => {
  beforeEach(() => {
    vi.mocked(fetchNotificationSettings).mockResolvedValue({ linkBaseUrl: 'http://chatter.local:3001', timeZone: 'America/Chicago' });
    vi.mocked(updateChannel).mockReset();
    vi.mocked(sendTestMessage).mockReset();
    vi.mocked(saveNotificationSettings).mockReset();
    vi.mocked(fetchMessages).mockReset();
    vi.mocked(fetchChannels).mockReset();
  });

  it('shows each channel with its type, what it gets, and its machines', async () => {
    await renderTab();

    expect(channelRow('Shop phones')).toHaveTextContent('Text message (Twilio) · 2 phones');
    expect(channelRow('Shop phones')).toHaveTextContent('Critical only');
    expect(channelRow('Shop phones')).toHaveTextContent('All machines');
    expect(channelRow('Slack #shop-floor')).toHaveTextContent('Warning and up');
    expect(channelRow('Slack #shop-floor')).toHaveTextContent('Haas VF-2');
  });

  it('shows the last message of a channel, and the error of a failed one', async () => {
    await renderTab([
      message({ id: 2, channelId: 'slack', status: 'failed', lastError: 'The address answered 404 Not found.', detail: null }),
      message({ id: 1 }),
    ]);

    expect(channelRow('Shop phones')).toHaveTextContent('Sent');
    expect(channelRow('Slack #shop-floor')).toHaveTextContent('Failed');
    expect(channelRow('Slack #shop-floor')).toHaveTextContent('The address answered 404 Not found.');
  });

  it('turns a channel off, and keeps its saved secrets and its ignore patterns', async () => {
    vi.mocked(updateChannel).mockResolvedValue({ ...phones, enabled: false });
    await renderTab();

    const toggle = screen.getByRole('switch', { name: 'Shop phones on' });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeEnabled());
    expect(updateChannel).toHaveBeenCalledWith('phones', {
      type: 'twilio-sms', name: 'Shop phones', values: phones.settings, minSeverity: 'critical', machineIds: null,
      ignorePatterns: ['Door open'], enabled: false,
    });
  });

  it('sends a test to a saved channel and shows the result', async () => {
    vi.mocked(sendTestMessage).mockResolvedValue({ ok: false, error: 'Twilio does not accept the Auth token.' });
    await renderTab();

    fireEvent.click(within(channelRow('Shop phones')).getByRole('button', { name: 'Send test' }));

    expect(await screen.findByText('Twilio does not accept the Auth token.')).toBeInTheDocument();
    expect(sendTestMessage).toHaveBeenCalledWith(expect.objectContaining({ name: 'Shop phones' }), 'phones');
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledTimes(2));
  });

  it('adds a channel in the side panel, and closes the panel', async () => {
    vi.mocked(addChannel).mockResolvedValue(slack);
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const panel = screen.getByRole('dialog', { name: 'Add channel' });
    fireEvent.change(within(panel).getByLabelText('Type'), { target: { value: 'webhook' } });
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'Slack' } });
    fireEvent.change(within(panel).getByLabelText('Web address'), { target: { value: 'https://hooks.slack.com/x' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save channel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add channel' })).not.toBeInTheDocument());
    expect(addChannel).toHaveBeenCalledWith(expect.objectContaining({ type: 'webhook', name: 'Slack', values: { url: 'https://hooks.slack.com/x' } }));
  });

  it('opens a saved channel to change it', async () => {
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Shop phones' }));

    expect(screen.getByRole('dialog', { name: 'Edit Shop phones' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account SID')).toHaveValue('AC1');
  });

  it('deletes a channel after the admin confirms, and closes the panel', async () => {
    vi.mocked(removeChannel).mockResolvedValue();
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Slack #shop-floor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the channel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(removeChannel).toHaveBeenCalledWith('slack');
    expect(fetchChannels).toHaveBeenCalledTimes(2);
  });

  it('shows the messages, and filters them by channel', async () => {
    await renderTab([
      message({ id: 2, channelId: 'slack', text: 'Slack text', detail: 'Sent' }),
      message({ id: 1, text: 'Phone text' }),
    ]);
    const messages = screen.getByRole('region', { name: 'Messages' });

    expect(within(messages).getByText('Slack text')).toBeInTheDocument();
    fireEvent.change(within(messages).getByLabelText('Channel'), { target: { value: 'phones' } });

    expect(within(messages).queryByText('Slack text')).not.toBeInTheDocument();
    expect(within(messages).getByText('Phone text')).toBeInTheDocument();
  });

  describe('a long message list', () => {
    const manyMessages = (count: number, channelId = 'phones') =>
      Array.from({ length: count }, (_, index) => message({ id: count - index, channelId, text: `Message ${count - index}` }));
    const messageRows = () => within(screen.getByRole('region', { name: 'Messages' })).getAllByRole('row').slice(1);

    it('shows the newest 10 messages and a button for more', async () => {
      await renderTab(manyMessages(120));

      expect(messageRows()).toHaveLength(10);
      expect(messageRows()[0]).toHaveTextContent('Message 120');
      expect(screen.getByText('Showing 10 of 120 messages.')).toBeInTheDocument();
    });

    it('shows 10 more each time the admin clicks Show more, and then no button', async () => {
      await renderTab(manyMessages(25));

      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(messageRows()).toHaveLength(20);

      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(messageRows()).toHaveLength(25);
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    });

    it('shows no button when all the messages fit', async () => {
      await renderTab(manyMessages(10));

      expect(messageRows()).toHaveLength(10);
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    });

    it('starts again at 10 when the admin selects another channel', async () => {
      await renderTab([...manyMessages(60, 'slack').map(entry => ({ ...entry, id: entry.id + 100 })), ...manyMessages(80)]);
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(messageRows()).toHaveLength(20);

      fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'phones' } });

      expect(messageRows()).toHaveLength(10);
      expect(screen.getByText('Showing 10 of 80 messages.')).toBeInTheDocument();
    });
  });

  describe('new messages', () => {
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

    it('loads the messages again every 20 seconds, and not the other parts of the tab', async () => {
      await renderTab([message({ id: 1, text: 'Old message' })]);
      vi.mocked(fetchMessages).mockResolvedValue([message({ id: 2, text: 'New message' }), message({ id: 1, text: 'Old message' })]);
      const channelLoads = vi.mocked(fetchChannels).mock.calls.length;

      await vi.advanceTimersByTimeAsync(20_000);

      expect(await screen.findByText('New message')).toBeInTheDocument();
      expect(fetchMessages).toHaveBeenCalledTimes(2);
      expect(fetchChannels).toHaveBeenCalledTimes(channelLoads);
    });

    it('does not load while the page is hidden, and loads at once when the page shows again', async () => {
      await renderTab();
      visibility = 'hidden';

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMessages).toHaveBeenCalledTimes(1);

      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(fetchMessages).toHaveBeenCalledTimes(2));
    });

    it('keeps the list when a load fails, for example while the server restarts', async () => {
      await renderTab([message({ id: 1, text: 'Old message' })]);
      vi.mocked(fetchMessages).mockRejectedValue(new Error('offline'));

      await vi.advanceTimersByTimeAsync(20_000);

      expect(screen.getByText('Old message')).toBeInTheDocument();
    });

    it('stops loading when the admin leaves the tab', async () => {
      await renderTab();
      cleanup();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(fetchMessages).toHaveBeenCalledTimes(1);
    });
  });

  it('shows the error of a failed message in the message list', async () => {
    await renderTab([message({ status: 'failed', lastError: 'Twilio says: unverified number.', detail: null })]);

    expect(within(screen.getByRole('region', { name: 'Messages' })).getByText('Twilio says: unverified number.')).toBeInTheDocument();
  });

  it('shows why a waiting message did not go yet, for example a limit of the service', async () => {
    const error = 'ntfy.sh allows 250 messages each day for each network (IP address). The limit is used.';
    await renderTab([message({ status: 'waiting', attempts: 3, lastError: error, detail: null, sentAt: null })]);

    expect(within(screen.getByRole('region', { name: 'Messages' })).getByText(error)).toBeInTheDocument();
  });

  it('shows a grouped message as Grouped, with the reason', async () => {
    const reason = 'In one summary message, because the service did not take messages for a time.';
    await renderTab([message({ status: 'grouped', detail: reason, sentAt: null })]);

    const messages = within(screen.getByRole('region', { name: 'Messages' }));
    expect(messages.getByText('Grouped')).toBeInTheDocument();
    expect(messages.getByText(reason)).toBeInTheDocument();
  });

  it('shows an ignored message as Ignored, with the pattern that matched', async () => {
    await renderTab([message({ status: 'ignored', detail: 'Ignored by the pattern "In alarm"', attempts: 0, sentAt: null })]);

    const messages = within(screen.getByRole('region', { name: 'Messages' }));
    expect(messages.getByText('Ignored')).toBeInTheDocument();
    expect(messages.getByText('Ignored by the pattern "In alarm"')).toBeInTheDocument();
  });

  it('fills the time zone from the browser when none is saved', async () => {
    vi.mocked(fetchNotificationSettings).mockResolvedValue({ linkBaseUrl: null, timeZone: null });
    await renderTab();

    expect(screen.getByLabelText('Time zone')).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByText(/from this browser/)).toBeInTheDocument();
  });

  it('saves the message settings', async () => {
    vi.mocked(saveNotificationSettings).mockResolvedValue({ linkBaseUrl: 'http://10.0.0.5:3001', timeZone: 'America/Chicago' });
    await renderTab();

    fireEvent.change(screen.getByLabelText('Chatter address for links'), { target: { value: 'http://10.0.0.5:3001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(saveNotificationSettings).toHaveBeenCalledWith({ linkBaseUrl: 'http://10.0.0.5:3001', timeZone: 'America/Chicago' });
  });

  it('shows a failed save of the settings next to the settings', async () => {
    vi.mocked(saveNotificationSettings).mockRejectedValue(new Error('Chatter does not know this time zone'));
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    const settings = screen.getByRole('region', { name: 'Message settings' });
    expect(await within(settings).findByText('Chatter does not know this time zone')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Channels' })).queryByText('Chatter does not know this time zone')).not.toBeInTheDocument();
  });
});
