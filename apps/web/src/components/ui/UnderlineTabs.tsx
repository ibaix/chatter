import { cn } from '@toolpath/ui';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { tabId, tabPanelId } from './tabPanel';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** A number after the label, such as the number of files */
  count?: number;
}

interface UnderlineTabsProps<T extends string> {
  /** Read by screen readers */
  label: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The id start of each tab and its panel. Use `tabPanelProps` for the panel. */
  idPrefix: string;
  className?: string;
}

/** The tab that a key goes to, from the tab at `index`, or null for a key that does not move */
function targetIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Tabs with a green line under the open one. The page shows the open tab's content itself.
 * The keyboard works as in the WAI-ARIA tabs pattern: the Tab key goes to the open tab only, and
 * Left, Right, Home and End open another tab at once (automatic activation).
 */
export function UnderlineTabs<T extends string>({ label, tabs, value, onChange, idPrefix, className }: UnderlineTabsProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const moveWithKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = targetIndex(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    onChange(tabs[target].id);
  };

  return (
    <div role="tablist" aria-label={label} className={cn('flex flex-wrap gap-x-1 border-b border-zinc-800', className)}>
      {tabs.map((tab, index) => {
        const isOpen = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={button => {
              buttons.current[index] = button;
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={isOpen}
            aria-controls={tabPanelId(idPrefix)}
            tabIndex={isOpen ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={event => moveWithKey(event, index)}
            className={cn(
              'min-h-12 border-0 border-b-2 bg-transparent px-3 font-bold whitespace-nowrap',
              isOpen ? 'border-primary text-zinc-50' : 'border-transparent text-zinc-200 hover:text-zinc-50',
            )}
          >
            {tab.label}
            {/* A real space before the count, so the tab name reads "Tool table 2" and not "Tool table2" */}
            {tab.count !== undefined && <> <span className="ml-0.5 font-mono font-medium text-zinc-300">{tab.count}</span></>}
          </button>
        );
      })}
    </div>
  );
}
