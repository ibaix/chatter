import { useState } from 'react';
import { fetchHelperLog } from '../../api/diagnostics';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { Panel } from '../../components/ui/Panel';
import { errorMessageOf } from '../../utils/errorMessage';

type HelperLog = { kind: 'text'; text: string } | { kind: 'none' } | { kind: 'error'; message: string };

/**
 * The log of the update helper on the Pi: what it did in each check, install and restart.
 * Only a helper from a newer card image writes it. Before, this needed SSH and "journalctl -u chatter-update".
 */
export function HelperLogPanel() {
  const [log, setLog] = useState<HelperLog | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = async () => {
    setIsLoading(true);
    try {
      const text = await fetchHelperLog();
      setLog(text === null ? { kind: 'none' } : { kind: 'text', text });
    } catch (error) {
      setLog({ kind: 'error', message: errorMessageOf(error, 'Could not load the helper log') });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Panel
      title="Update helper log"
      description="What the update helper of the Pi did, with the time of each step."
      actions={<Button onClick={load} disabled={isLoading}>{log ? 'Load again' : 'Show the log'}</Button>}
    >
      {log?.kind === 'text' && (
        <pre aria-label="Update helper log" className="m-0 max-h-96 overflow-auto px-5 py-4 font-mono text-xs whitespace-pre-wrap">
          {log.text || 'The log is empty.'}
        </pre>
      )}
      {log?.kind === 'none' && (
        <div className="px-5 py-4">
          <Notice tone="info" title="This Pi has no helper log yet">
            The update helper of this Pi does not write a log that Chatter can read. A new card image is necessary for this.
          </Notice>
        </div>
      )}
      {log?.kind === 'error' && <div className="px-5 py-4"><Notice tone="error" title={log.message} /></div>}
    </Panel>
  );
}
