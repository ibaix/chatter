import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { tabPanelProps } from '../../components/ui/tabPanel';
import { UnderlineTabs, type TabItem } from '../../components/ui/UnderlineTabs';
import type { Machine, MachineUpdate, ToolTable } from '../../types';
import { FilesSection } from './FilesSection';
import { ReportPanel } from './ReportPanel';
import { SettingsTab } from './SettingsTab';
import { ToolTableTab } from './ToolTableTab';
import { useAlertRules } from './useAlertRules';
import { useMachineFiles } from './useMachineFiles';
import { useUploadHistory } from './useUploadHistory';
import { useUploadMessages } from './useUploadMessages';

type SectionId = 'dashboard' | 'report' | 'files' | 'tools' | 'settings';

const ID_PREFIX = 'machine-sections';
/** The address keeps the open tab (for example /machine/m1?tab=report), so a reload or a link opens the same tab */
const TAB_PARAM = 'tab';
/** The tabs that hold a list or a form. They share one card. Dashboard and Report hold cards of their own. */
const CARD_TABS: readonly SectionId[] = ['files', 'tools', 'settings'];

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
  /** The Dashboard tab shows this number of firing alerts */
  firingCount: number;
}

/** The tabs under the machine name: the dashboard, the report, files, tool table and settings */
export function MachineSections({ machine, machines, now, onUpdate, onRemove, dashboard, firingCount }: MachineSectionsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const openTab = searchParams.get(TAB_PARAM);
  const files = useMachineFiles(machine.id);
  const history = useUploadHistory(machine.id);
  const messages = useUploadMessages();
  const alertRules = useAlertRules(machine.id);
  const { toolTable, hasPocketInfo } = toolTableOf(machine);
  const toolCount = machine.connected && toolTable ? Object.keys(toolTable).length : 0;

  const tabs: TabItem<SectionId>[] = [
    { id: 'dashboard', label: <>Dashboard<FiringCount count={firingCount} /></> },
    { id: 'report', label: 'Report' },
    { id: 'files', label: 'Files' },
    ...(toolCount > 0 ? [{ id: 'tools' as const, label: 'Tool table', count: toolCount }] : []),
    { id: 'settings', label: 'Settings' },
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
            {shownTab === 'files' && (
              <FilesSection
                machineId={machine.id}
                machineName={machine.name}
                files={files}
                history={history}
                messages={messages}
                onUploaded={reloadAfterUpload}
                now={now}
              />
            )}
            {shownTab === 'tools' && toolTable && (
              <ToolTableTab toolTable={toolTable} hasPocketInfo={hasPocketInfo} spindleTool={machine.data.toolNumber} />
            )}
            {shownTab === 'settings' && (
              <SettingsTab machine={machine} machines={machines} rules={alertRules} onUpdate={onUpdate} onRemove={onRemove} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** The number of firing alerts after the Dashboard tab name, in the alarm color. Nothing when no alert fires. */
function FiringCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-alarm px-1.5 font-mono text-xs font-bold text-white">
      {count}
      <span className="sr-only"> {count === 1 ? 'alert' : 'alerts'} firing</span>
    </span>
  );
}
