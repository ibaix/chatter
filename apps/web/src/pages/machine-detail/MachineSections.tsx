import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCan } from '../../components/CurrentUser';
import { Notice } from '../../components/ui/Notice';
import { tabPanelProps } from '../../components/ui/tabPanel';
import { UnderlineTabs, type TabItem } from '../../components/ui/UnderlineTabs';
import type { Machine, MachineUpdate, ToolTable } from '../../types';
import { AlertRulesTab } from './AlertRulesTab';
import { FilesTab } from './FilesTab';
import { MachineSettingsTab } from './MachineSettingsTab';
import { ReportPanel } from './ReportPanel';
import { ToolTableTab } from './ToolTableTab';
import { UploadHistoryTab } from './UploadHistoryTab';
import { useAlertRules } from './useAlertRules';
import { useMachineFiles } from './useMachineFiles';
import { useUploadHistory } from './useUploadHistory';
import { useUploadMessages, type UploadMessages } from './useUploadMessages';

type SectionId = 'dashboard' | 'report' | 'files' | 'history' | 'tools' | 'alerts' | 'settings';

const ID_PREFIX = 'machine-sections';
/** The address keeps the open tab (for example /machine/m1?tab=report), so a reload or a link opens the same tab */
const TAB_PARAM = 'tab';
/** The tabs that hold a list or a form. They share one card. Dashboard and Report hold cards of their own. */
const CARD_TABS: readonly SectionId[] = ['files', 'history', 'tools', 'alerts', 'settings'];

/** Brother and Haas machines send their tool table. Only Brother tells which pocket holds each tool. */
function toolTableOf(machine: Machine): { toolTable: ToolTable | undefined; hasPocketInfo: boolean } {
  if (machine.type === 'brother') return { toolTable: machine.data.toolTable, hasPocketInfo: !!machine.data.hasPocketInfo };
  // The Haas data type does not list the tool table, so say what it is
  if (machine.type === 'haas') return { toolTable: machine.data.toolTable as ToolTable | undefined, hasPocketInfo: false };
  return { toolTable: undefined, hasPocketInfo: false };
}

interface MachineSectionsProps {
  machine: Machine;
  /** All machines. The alert rules can be copied to the others. */
  machines: Machine[];
  now: number;
  onUpdate: (id: string, updates: MachineUpdate) => Promise<boolean>;
  onRemove: () => Promise<void>;
  /** The live values, the chart and the alerts */
  dashboard: ReactNode;
}

/** The tabs under the machine name: the dashboard, the report, files, upload history, tool table, alert rules and settings */
export function MachineSections({ machine, machines, now, onUpdate, onRemove, dashboard }: MachineSectionsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const openTab = searchParams.get(TAB_PARAM);
  const canManageMachines = useCan('manage-machines');
  const files = useMachineFiles(machine.id);
  const history = useUploadHistory(machine.id);
  const messages = useUploadMessages();
  const alertRules = useAlertRules(machine.id);
  const { toolTable, hasPocketInfo } = toolTableOf(machine);
  const toolCount = machine.connected && toolTable ? Object.keys(toolTable).length : 0;

  const tabs: TabItem<SectionId>[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'report', label: 'Report' },
    { id: 'files', label: 'Files' },
    { id: 'history', label: 'Upload history', count: history.historyFiles.length },
    ...(toolCount > 0 ? [{ id: 'tools' as const, label: 'Tool table', count: toolCount }] : []),
    { id: 'alerts', label: 'Alert rules', count: alertRules.saved?.length },
    ...(canManageMachines ? [{ id: 'settings' as const, label: 'Machine settings' }] : []),
  ];
  // An unknown tab, or a tab that is not there (the tool table goes away when the machine stops sending it), opens the dashboard
  const shownTab = tabs.find(tab => tab.id === openTab)?.id ?? 'dashboard';
  const openTabNamed = (tab: SectionId) => setSearchParams({ [TAB_PARAM]: tab }, { replace: true });

  const reloadAfterUpload = async () => {
    files.refresh();
    await history.refreshAll();
  };

  return (
    <>
      <UnderlineTabs label="Machine sections" tabs={tabs} value={shownTab} onChange={openTabNamed} idPrefix={ID_PREFIX} />
      <div {...tabPanelProps(ID_PREFIX, shownTab)} className="flex flex-col gap-5">
        {shownTab === 'dashboard' && dashboard}
        {shownTab === 'report' && <ReportPanel machineId={machine.id} machineType={machine.type} />}
        {CARD_TABS.includes(shownTab) && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900">
            {(shownTab === 'files' || shownTab === 'history') && <UploadMessageNotices messages={messages} />}
            {shownTab === 'files' && (
              <FilesTab machineId={machine.id} files={files} messages={messages} onUploaded={reloadAfterUpload} now={now} />
            )}
            {shownTab === 'history' && (
              <UploadHistoryTab
                machineId={machine.id}
                machineName={machine.name}
                history={history}
                messages={messages}
                onUploaded={reloadAfterUpload}
              />
            )}
            {shownTab === 'tools' && toolTable && (
              <ToolTableTab toolTable={toolTable} hasPocketInfo={hasPocketInfo} spindleTool={machine.data.toolNumber} />
            )}
            {shownTab === 'alerts' && (
              <AlertRulesTab
                machineId={machine.id}
                otherMachines={machines.filter(other => other.id !== machine.id)}
                rules={alertRules}
              />
            )}
            {shownTab === 'settings' && (
              <MachineSettingsTab machine={machine} onUpdate={onUpdate} onRemove={onRemove} />
            )}
          </div>
        )}
      </div>
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
