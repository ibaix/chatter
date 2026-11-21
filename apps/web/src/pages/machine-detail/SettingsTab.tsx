import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useCan } from '../../components/CurrentUser';
import type { Machine, MachineUpdate } from '../../types';
import { AlertRulesSection } from './AlertRulesSection';
import { MachineSettingsSection } from './MachineSettingsSection';
import type { AlertRules } from './useAlertRules';

/** The id of each section. A link to `?tab=settings#<id>` opens the Settings tab at that section. */
export const SETTINGS_SECTION_IDS = { machine: 'settings-machine', alertRules: 'settings-alert-rules' } as const;

interface SettingsTabProps {
  machine: Machine;
  /** All machines. The alert rules can be copied to the others. */
  machines: Machine[];
  rules: AlertRules;
  onUpdate: (id: string, updates: MachineUpdate) => Promise<boolean>;
  onRemove: () => Promise<void>;
}

/**
 * The machine settings (for an admin only) and the alert rules (for each user, read only when the user is not an admin).
 * A small menu jumps to each section.
 */
export function SettingsTab({ machine, machines, rules, onUpdate, onRemove }: SettingsTabProps) {
  const canManageMachines = useCan('manage-machines');
  useScrollToSection(!!rules.saved);

  const alertRules = (
    <SettingsSection id={SETTINGS_SECTION_IDS.alertRules} title="Alert rules">
      <AlertRulesSection machineId={machine.id} otherMachines={machines.filter(other => other.id !== machine.id)} rules={rules} />
    </SettingsSection>
  );
  if (!canManageMachines) return alertRules;

  return (
    <div className="flex flex-wrap">
      <nav aria-label="Settings sections" className="flex flex-[1_1_10rem] flex-col gap-0.5 border-zinc-800 p-3 md:max-w-[13rem] md:border-r">
        <SectionLink id={SETTINGS_SECTION_IDS.machine}>Machine</SectionLink>
        <SectionLink id={SETTINGS_SECTION_IDS.alertRules}>
          Alert rules
          {rules.saved && <span className="ml-1.5 font-mono font-medium text-zinc-300">{rules.saved.length}</span>}
        </SectionLink>
      </nav>
      <div className="flex min-w-0 flex-[999_1_30rem] flex-col">
        <SettingsSection id={SETTINGS_SECTION_IDS.machine} title="Machine">
          <MachineSettingsSection machine={machine} onUpdate={onUpdate} onRemove={onRemove} />
        </SettingsSection>
        <div className="border-t border-zinc-800">{alertRules}</div>
      </div>
    </div>
  );
}

/**
 * A link from another tab to `#<id>` opens the Settings tab. The browser does not scroll then, so this does it.
 * It scrolls again when the alert rules load: before that, the page can be too short to bring the section to the top.
 */
function useScrollToSection(rulesLoaded: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, rulesLoaded]);
}

function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const titleId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-4">
      <h2 id={titleId} className="m-0 px-4 pt-4 text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

function SectionLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a href={`#${id}`} className="flex min-h-9 items-center rounded-md px-2 font-semibold text-zinc-100 no-underline hover:bg-zinc-800">
      {children}
    </a>
  );
}
