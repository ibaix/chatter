import { cn } from '@toolpath/ui';
import { useState } from 'react';
import type { NotificationChannel, NotificationMessage } from '../../api/notifications';
import { Button } from '../../components/ui/Button';
import { Field, SelectInput } from '../../components/ui/fields';
import { Panel } from '../../components/ui/Panel';
import { CELL, HEAD_CELL, HEAD_ROW, ROW, TABLE } from '../../components/ui/table';
import { formatDateTime } from '../../utils/formatters';
import { MessageResult } from './MessageResult';
import { KIND_LABELS } from './notificationLabels';

const ALL_CHANNELS = '';
/** The list can have up to 1000 messages, so it shows this many at first, and this many more for each click */
export const MESSAGES_PAGE_SIZE = 50;
const NO_CHANNEL_NAME = 'Deleted channel';

interface MessagesPanelProps {
  channels: NotificationChannel[];
  /** The messages of the last 30 days, the newest first */
  messages: NotificationMessage[];
}

/** Each message that Chatter sent or tried to send in the last 30 days, and its result */
export function MessagesPanel({ channels, messages }: MessagesPanelProps) {
  const [channelId, setChannelId] = useState(ALL_CHANNELS);
  const [shownCount, setShownCount] = useState(MESSAGES_PAGE_SIZE);
  const matching = channelId === ALL_CHANNELS ? messages : messages.filter(message => message.channelId === channelId);
  const shown = matching.slice(0, shownCount);
  const pickChannel = (id: string) => {
    setChannelId(id);
    setShownCount(MESSAGES_PAGE_SIZE);
  };
  const channelNameOf = (id: string) => channels.find(channel => channel.id === id)?.name ?? NO_CHANNEL_NAME;

  return (
    <Panel
      title="Messages"
      description="The messages of the last 30 days. Chatter removes older ones."
      actions={<ChannelFilter channels={channels} value={channelId} onChange={pickChannel} />}
    >
      {shown.length === 0 ? (
        <p className="m-0 px-5 py-4 text-zinc-200">No messages in the last 30 days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={cn(TABLE, 'min-w-[46rem]')}>
            <thead>
              <tr className={HEAD_ROW}>
                <th scope="col" className={HEAD_CELL}>Time</th>
                <th scope="col" className={HEAD_CELL}>Channel</th>
                <th scope="col" className={HEAD_CELL}>Message</th>
                <th scope="col" className={HEAD_CELL}>Result</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(message => (
                <MessageRow key={message.id} message={message} channelName={channelNameOf(message.channelId)} />
              ))}
            </tbody>
          </table>
          {matching.length > shown.length && (
            <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-5 py-3">
              <p className="m-0 text-xs text-zinc-300">Showing {shown.length} of {matching.length} messages.</p>
              <Button size="sm" onClick={() => setShownCount(count => count + MESSAGES_PAGE_SIZE)}>Show more</Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

interface ChannelFilterProps {
  channels: NotificationChannel[];
  value: string;
  onChange: (channelId: string) => void;
}

function ChannelFilter({ channels, value, onChange }: ChannelFilterProps) {
  return (
    <Field id="message-channel" label="Channel">
      <SelectInput id="message-channel" value={value} onChange={event => onChange(event.target.value)}>
        <option value={ALL_CHANNELS}>All channels</option>
        {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </SelectInput>
    </Field>
  );
}

function MessageRow({ message, channelName }: { message: NotificationMessage; channelName: string }) {
  return (
    <tr className={cn(ROW, 'align-top')}>
      <td className={cn(CELL, 'whitespace-nowrap text-zinc-200')}>{formatDateTime(message.createdAt)}</td>
      <td className={CELL}>{channelName}</td>
      <td className={CELL}>
        <div>{message.text}</div>
        <div className="text-xs text-zinc-300">{KIND_LABELS[message.kind]}</div>
      </td>
      <td className={CELL}>
        <MessageResult message={message} />
      </td>
    </tr>
  );
}
