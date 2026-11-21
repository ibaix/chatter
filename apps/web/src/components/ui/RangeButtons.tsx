import { SegmentedButtons } from './SegmentedButtons';

/** A time range that a button can show. The id is the button text, such as "24h". */
export interface RangeOption {
  id: string;
}

interface RangeButtonsProps<Option extends RangeOption> {
  options: readonly Option[];
  value: Option;
  onChange: (option: Option) => void;
}

/** A row of buttons for a time range. The pressed button shows the range in use. */
export function RangeButtons<Option extends RangeOption>({ options, value, onChange }: RangeButtonsProps<Option>) {
  const choose = (id: string) => {
    const option = options.find(candidate => candidate.id === id);
    if (option) onChange(option);
  };
  return (
    <SegmentedButtons
      label="Time range"
      options={options.map(option => ({ id: option.id, label: option.id }))}
      value={value.id}
      onChange={choose}
    />
  );
}
