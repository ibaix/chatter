import { useState } from 'react';
import { useCan } from '../../components/CurrentUser';
import { Button } from '../../components/ui/Button';
import { UploadIcon } from '../../components/ui/icons';
import { Notice } from '../../components/ui/Notice';
import { SegmentedButtons } from '../../components/ui/SegmentedButtons';
import { FilesTab } from './FilesTab';
import FileUploadPanel from './FileUploadPanel';
import { UploadHistoryTab } from './UploadHistoryTab';
import type { MachineFiles } from './useMachineFiles';
import type { UploadHistory } from './useUploadHistory';
import type { UploadMessages } from './useUploadMessages';

type FilesView = 'machine' | 'history';

interface FilesSectionProps {
  machineId: string;
  machineName: string;
  files: MachineFiles;
  history: UploadHistory;
  messages: UploadMessages;
  /** Called after each upload, so the files and the history load again */
  onUploaded: () => Promise<void>;
  now: number;
}

/** The Files tab: the files on the machine or the upload history, and Send files for both */
export function FilesSection({ machineId, machineName, files, history, messages, onUploaded, now }: FilesSectionProps) {
  const canSendFiles = useCan('send-files');
  const [view, setView] = useState<FilesView>('machine');
  const [isSending, setIsSending] = useState(false);

  const sendFinished = async () => {
    setIsSending(false);
    await onUploaded();
  };

  const views = [
    { id: 'machine' as const, label: 'On the machine' },
    {
      id: 'history' as const,
      label: (
        <>
          Upload history <span className="ml-1 font-mono font-medium text-zinc-300">{history.historyFiles.length}</span>
        </>
      ),
    },
  ];

  return (
    <>
      <UploadMessageNotices messages={messages} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <SegmentedButtons label="Files to show" options={views} value={view} onChange={setView} />
        {canSendFiles && (
          <Button variant="primary" onClick={() => setIsSending(true)} disabled={isSending}>
            <UploadIcon /> Send files
          </Button>
        )}
      </div>
      {isSending && (
        <div className="pt-4">
          <FileUploadPanel
            machineId={machineId}
            uploadPath={files.uploadPath}
            messages={messages}
            onUploaded={sendFinished}
            onCancel={() => setIsSending(false)}
          />
        </div>
      )}
      {view === 'machine' ? (
        <FilesTab machineId={machineId} files={files} messages={messages} now={now} />
      ) : (
        <UploadHistoryTab machineId={machineId} machineName={machineName} history={history} messages={messages} onUploaded={onUploaded} />
      )}
    </>
  );
}

/** The result of the last upload, above the files and the upload history */
function UploadMessageNotices({ messages }: { messages: UploadMessages }) {
  if (!messages.error && !messages.success) return null;
  return (
    <div className="px-4 pt-3">
      {messages.error && <Notice tone="error" title={messages.error} onClose={messages.clear} />}
      {messages.success && <Notice tone="success" title={messages.success} onClose={messages.clear} />}
    </div>
  );
}
