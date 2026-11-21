import { Switch } from '@toolpath/ui';
import { useEffect, useId, useRef, useState } from 'react';
import {
  fetchDebugState, logDownloadUrl, logStreamUrl, setDebug, supportBundleUrl, type DebugState, type LogFilter,
} from '../../api/diagnostics';
import { Button } from '../../components/ui/Button';
import { Field, SelectInput } from '../../components/ui/fields';
import { Notice } from '../../components/ui/Notice';
import { Panel } from '../../components/ui/Panel';
import { errorMessageOf } from '../../utils/errorMessage';
import type { MachineName } from './notificationLabels';

/** The live view keeps this many lines. Older lines go away, so a long view does not fill the memory of the browser. */
export const LIVE_LINES = 500;

const LEVELS: { value: NonNullable<LogFilter['level']> | ''; label: string }[] = [
  { value: '', label: 'All levels' },
  { value: 'info', label: 'Info and up' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];

const DOWNLOAD_LINK = 'inline-flex min-h-10 items-center rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 text-sm font-bold '
  + 'text-zinc-50 no-underline hover:bg-zinc-800';

/** The server log: download it, see it live, the support bundle, and the debug level */
export function LogPanel({ machines }: { machines: MachineName[] }) {
  const [filter, setFilter] = useState<LogFilter>({});
  const levelId = useId();
  const machineId = useId();

  return (
    <Panel title="Server log" description="Chatter hides passwords, tokens and secrets in each line.">
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field id={levelId} label="Level">
            <SelectInput
              id={levelId}
              value={filter.level ?? ''}
              onChange={event => setFilter({ ...filter, level: (event.target.value || undefined) as LogFilter['level'] })}
            >
              {LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
            </SelectInput>
          </Field>
          <Field id={machineId} label="Machine">
            <SelectInput
              id={machineId}
              value={filter.machine ?? ''}
              onChange={event => setFilter({ ...filter, machine: event.target.value || undefined })}
            >
              <option value="">All machines</option>
              {machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
            </SelectInput>
          </Field>
          <a className={DOWNLOAD_LINK} href={logDownloadUrl(filter)} download>Download the log</a>
          <a className={DOWNLOAD_LINK} href={supportBundleUrl()} download>Download the support bundle</a>
        </div>
        <p className="m-0 text-xs text-zinc-300">
          The support bundle has the version, the memory and the free space, the status of each machine, the update
          helper files, and the log. It has no passwords, tokens, notification addresses or topics.
        </p>
        <DebugSwitch />
        <LiveLog filter={filter} />
      </div>
    </Panel>
  );
}

function DebugSwitch() {
  const [state, setState] = useState<DebugState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  useEffect(() => {
    fetchDebugState().then(setState, () => {});
  }, []);

  const change = async (on: boolean) => {
    setError(null);
    try {
      setState(await setDebug(on));
    } catch (failure) {
      setError(errorMessageOf(failure, 'Could not change the log level'));
    }
  };

  const until = state?.debugUntil ? new Date(state.debugUntil).toLocaleTimeString() : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div id={labelId} className="flex flex-col gap-0.5">
          <span className="font-bold">Debug level for 15 minutes</span>
          <span className="text-sm text-zinc-200">
            {until ? `On until ${until}. Then it turns off by itself.` : 'The log has more lines, for example each poll. It turns off by itself.'}
          </span>
        </div>
        <Switch aria-labelledby={labelId} checked={state?.debugUntil != null} onCheckedChange={change} disabled={state === null} />
      </div>
      {error && <Notice tone="error" title={error} />}
    </div>
  );
}

/** The lines of the log as they come, from the server-sent events of /api/logs/stream */
function LiveLog({ filter }: { filter: LogFilter }) {
  const [isOn, setIsOn] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [isLost, setIsLost] = useState(false);
  const view = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!isOn) return;
    setLines([]);
    setIsLost(false);
    const source = new EventSource(logStreamUrl(filter));
    const add = (line: string) => setLines(current => [...current, line].slice(-LIVE_LINES));
    source.addEventListener('line', event => add((event as MessageEvent<string>).data));
    source.addEventListener('dropped', event => add(`[${(event as MessageEvent<string>).data} lines dropped: the browser was too slow]`));
    source.addEventListener('open', () => setIsLost(false));
    source.addEventListener('error', () => setIsLost(true));
    return () => source.close();
  }, [isOn, filter]);

  // The newest line stays in view
  useEffect(() => {
    if (view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [lines]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button onClick={() => setIsOn(!isOn)}>{isOn ? 'Stop the live log' : 'Show the live log'}</Button>
        {isOn && <span className="text-xs text-zinc-300">The last {LIVE_LINES} lines stay on the page.</span>}
      </div>
      {isOn && isLost && (
        <Notice tone="error" title="The live log is not connected">
          The page tries again. Chatter allows at most 3 live logs at the same time. Close the live log in other tabs.
        </Notice>
      )}
      {isOn && (
        <pre ref={view} aria-label="Live log" className="m-0 max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs whitespace-pre-wrap">
          {lines.length > 0 ? lines.join('\n') : 'Waiting for lines…'}
        </pre>
      )}
    </div>
  );
}
