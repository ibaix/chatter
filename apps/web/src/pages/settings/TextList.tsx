import type { HTMLInputTypeAttribute, ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { TextInput } from '../../components/ui/fields';
import { CloseIcon, PlusIcon } from '../../components/ui/icons';

interface TextListProps {
  /** The heading over the boxes */
  legend: string;
  /** One box for each entry. Give at least one entry, so the admin can type the first value. */
  values: string[];
  onChange: (values: string[]) => void;
  /** The name of one box, with its place, for example "Phone number" gives "Phone number 1" */
  itemLabel: string;
  /** The text of the button that adds a box, for example "Add a number" */
  addLabel: string;
  /** False hides the Add button, for a list that is at its limit */
  canAdd?: boolean;
  inputType?: HTMLInputTypeAttribute;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
  /** A line under a box, for example a preview of what the value does */
  below?: (value: string, index: number) => ReactNode;
}

/** A list of text boxes with a button to add a box and a button to remove each box. The last box cannot be removed. */
export function TextList({
  legend, values, onChange, itemLabel, addLabel, canAdd = true, inputType, placeholder, mono, hint, below,
}: TextListProps) {
  const setValue = (index: number, value: string) => onChange(values.map((entry, at) => (at === index ? value : entry)));
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-xs font-semibold text-zinc-300">{legend}</legend>
      {values.map((value, index) => (
        // The boxes have no id of their own, so the place in the list is the key
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <TextInput
              type={inputType}
              mono={mono}
              className="flex-1"
              value={value}
              placeholder={placeholder}
              aria-label={`${itemLabel} ${index + 1}`}
              onChange={event => setValue(index, event.target.value)}
              autoComplete="off"
            />
            {values.length > 1 && (
              <Button
                variant="quiet"
                size="icon"
                aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
                onClick={() => onChange(values.filter((_, at) => at !== index))}
              >
                <CloseIcon size={14} />
              </Button>
            )}
          </div>
          {below?.(value, index)}
        </div>
      ))}
      {canAdd && (
        <div>
          <Button size="sm" onClick={() => onChange([...values, ''])}><PlusIcon /> {addLabel}</Button>
        </div>
      )}
      {hint && <p className="m-0 text-xs text-zinc-300">{hint}</p>}
    </fieldset>
  );
}
