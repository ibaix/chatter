import { cn } from '@toolpath/ui';
import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
}

interface SegmentedButtonsProps<T extends string> {
  /** Read by screen readers, for example "Time range" */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** A row of buttons in one box. One button is pressed at a time, and it shows the choice in use. */
export function SegmentedButtons<T extends string>({ label, options, value, onChange, className }: SegmentedButtonsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex gap-0.5 rounded-lg bg-zinc-950 p-[0.1875rem]', className)}>
      {options.map(option => {
        const isPressed = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isPressed}
            onClick={() => onChange(option.id)}
            className={cn(
              'min-h-8 rounded-md border-0 px-2.5',
              isPressed ? 'bg-zinc-700 font-bold text-zinc-50' : 'bg-transparent font-semibold text-zinc-200 hover:text-zinc-50',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
