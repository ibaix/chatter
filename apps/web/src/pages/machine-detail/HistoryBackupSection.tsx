import { useId, useState } from 'react';
import {
  backupDownloadUrl,
  cancelRestore,
  confirmRestore,
  prepareBackup,
  uploadRestoreFile,
  type RestorePreview,
  type RestoreResult,
} from '../../api/historyBackup';
import { Button } from '../../components/ui/Button';
import { Field, TextInput } from '../../components/ui/fields';
import { FileButton } from '../../components/ui/FileButton';
import { Notice } from '../../components/ui/Notice';
import type { Machine } from '../../types';
import { errorMessageOf } from '../../utils/errorMessage';
import { formatDateTime, formatSize } from '../../utils/formatters';

const UNKNOWN_ERROR = 'Something went wrong. Try again.';

type Message = { tone: 'success' | 'error'; text: string } | null;

interface HistoryBackupSectionProps {
  machine: Machine;
  /** Only an admin can restore, because a restore writes into the history */
  canRestore: boolean;
}

/**
 * Back up the history of this machine to a file, and restore such a file.
 * For example, to keep the history of a machine before it is deleted, and to put it back when the machine is added again.
 */
export function HistoryBackupSection({ machine, canRestore }: HistoryBackupSectionProps) {
  return (
    <div className="flex flex-col gap-5 p-4">
      <p className="m-0 text-sm text-zinc-200">
        The file has the machine values, the state periods (program, alarm, mode, run state and tool) and the alert rules of this
        machine. It has no address, user name or password. When you delete a machine, Chatter deletes its history. Back it up
        first if you want to keep it.
      </p>
      <BackupForm machine={machine} />
      {canRestore && <RestoreForm machine={machine} />}
    </div>
  );
}

/** The start of the day in the date box (local time), in milliseconds, or null when the box is empty */
function dayStart(date: string): number | null {
  return date ? new Date(`${date}T00:00:00`).getTime() : null;
}

/** The end of the day in the date box: the start of the next day. A day with a change of summer time has 23 or 25 hours. */
function dayEnd(date: string): number | null {
  if (!date) return null;
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.getTime();
}

function BackupForm({ machine }: { machine: Machine }) {
  const fromId = useId();
  const toId = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [averagesOnly, setAveragesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const backUp = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const toDay = dayEnd(to);
      const prepared = await prepareBackup(machine.id, { from: dayStart(from), ...(toDay !== null && { to: toDay }), averagesOnly });
      startDownload(backupDownloadUrl(machine.id, prepared.id), prepared.fileName);
      const bytes = Object.values(prepared.parts).reduce((sum, part) => sum + (part?.bytes ?? 0), 0);
      setMessage({ tone: 'success', text: `The download of ${prepared.fileName} (about ${formatSize(bytes)}) started.` });
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessageOf(error, UNKNOWN_ERROR) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Back up history" className="flex flex-col gap-3">
      <h4 className="m-0 text-sm font-bold">Back up</h4>
      <div className="flex flex-wrap gap-3">
        <Field id={fromId} label="From (empty: all the history)">
          <TextInput id={fromId} type="date" value={from} onChange={event => setFrom(event.target.value)} disabled={busy} />
        </Field>
        <Field id={toId} label="To (empty: now)">
          <TextInput id={toId} type="date" value={to} onChange={event => setTo(event.target.value)} disabled={busy} />
        </Field>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox" checked={averagesOnly} onChange={event => setAveragesOnly(event.target.checked)} disabled={busy}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="flex flex-col gap-0.5">
          <span>1-minute averages only (a much smaller file)</span>
          <span className="text-xs text-zinc-300">
            The charts and the time online and running stay. The values of each poll and the part count of the report are not in the file.
          </span>
        </span>
      </label>
      <div>
        <Button onClick={backUp} disabled={busy}>{busy ? 'Reading the history…' : 'Back up history'}</Button>
      </div>
      {message && <Notice tone={message.tone} title={message.text} />}
    </section>
  );
}

/** The browser saves the file. The server sends it as an attachment, so the page stays. */
function startDownload(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

function RestoreForm({ machine }: { machine: Machine }) {
  const [sent, setSent] = useState<number | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const upload = async (file: File) => {
    setMessage(null);
    setPreview(null);
    setSent(0);
    try {
      setPreview(await uploadRestoreFile(machine.id, file, setSent));
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessageOf(error, UNKNOWN_ERROR) });
    } finally {
      setSent(null);
    }
  };

  const done = (result: RestoreResult) => {
    setPreview(null);
    setMessage({ tone: 'success', text: resultText(result) });
  };

  return (
    <section aria-label="Restore history" className="flex flex-col gap-3">
      <h4 className="m-0 text-sm font-bold">Restore</h4>
      <p className="m-0 text-xs text-zinc-300">
        Chatter checks all of the file first, and shows what it has. Then you confirm. A second restore of the same file does not
        add the history two times.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <FileButton inputLabel="Backup file to restore" accept=".gz" disabled={sent !== null} onFile={upload}>
          {sent === null ? 'Restore history' : 'Checking the file…'}
        </FileButton>
        {sent !== null && <progress aria-label="Upload" value={sent} max={1} className="h-2 flex-1 accent-primary" />}
      </div>
      {preview && (
        <RestorePreviewPanel
          machine={machine} preview={preview} onDone={done}
          onCancel={() => {
            setPreview(null);
            void cancelRestore(machine.id, preview.id).catch(() => {});
          }}
        />
      )}
      {message && <Notice tone={message.tone} title={message.text} />}
    </section>
  );
}

function resultText({ samples, periodsAdded, periodsKnown, alertRules }: RestoreResult): string {
  const known = periodsKnown > 0 ? ` (${periodsKnown} were there already)` : '';
  const rules = alertRules === null ? '' : ` The alert rules of the file (${alertRules}) replace the alert rules of this machine.`;
  return `The history is restored: ${samples.toLocaleString()} values and ${periodsAdded.toLocaleString()} state periods${known}.${rules}`;
}

interface RestorePreviewPanelProps {
  machine: Machine;
  preview: RestorePreview;
  onDone: (result: RestoreResult) => void;
  onCancel: () => void;
}

function RestorePreviewPanel({ machine, preview, onDone, onCancel }: RestorePreviewPanelProps) {
  const [alertRules, setAlertRules] = useState(preview.counts.alertRules > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await confirmRestore(machine.id, preview.id, alertRules));
    } catch (thrown) {
      setError(errorMessageOf(thrown, UNKNOWN_ERROR));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Restore preview" className="flex flex-col gap-3 rounded-lg border border-zinc-700 p-3">
      <PreviewFacts machine={machine} preview={preview} />
      {(preview.tooOld.samples > 0 || preview.tooOld.periods > 0) && (
        <Notice tone="info" title="Some of the history is older than 1 year">
          Chatter keeps the history for 1 year. It does not restore {preview.tooOld.samples.toLocaleString()} values and{' '}
          {preview.tooOld.periods.toLocaleString()} state periods.
        </Notice>
      )}
      {preview.counts.alertRules > 0 && (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox" checked={alertRules} onChange={event => setAlertRules(event.target.checked)} disabled={busy}
            className="mt-0.5 size-4 accent-primary"
          />
          <span className="flex flex-col gap-0.5">
            <span>Also restore the alert rules</span>
            <span className="text-xs text-zinc-300">The {preview.counts.alertRules} rules of the file replace the alert rules of this machine.</span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={restore} disabled={busy}>{busy ? 'Restoring…' : `Restore into ${machine.name}`}</Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      {error && <Notice tone="error" title={error} />}
    </section>
  );
}

function PreviewFacts({ machine, preview }: { machine: Machine; preview: RestorePreview }) {
  const { source, counts, data } = preview;
  const facts: [string, string][] = [
    ['From the machine', `${source.name} (${source.type})${preview.sameMachine ? ', this machine' : ''}`],
    ['Made', `${formatDateTime(preview.createdAt)} by Chatter ${preview.chatterVersion}`],
    ['History from', data.first === null ? 'No history' : `${formatDateTime(new Date(data.first).toISOString())} to ${formatDateTime(new Date(data.last ?? data.first).toISOString())}`],
    ['Values', preview.averagesOnly ? `${counts.averageSamples.toLocaleString()} averages (1-minute averages only)` : `${counts.rawSamples.toLocaleString()} values and ${counts.averageSamples.toLocaleString()} averages`],
    ['State periods', counts.periods.toLocaleString()],
    ['Alert rules', counts.alertRules.toLocaleString()],
  ];
  return (
    <>
      <p className="m-0 text-sm font-bold">Restore this file into {machine.name}?</p>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-300">{label}</dt>
            <dd className="m-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
