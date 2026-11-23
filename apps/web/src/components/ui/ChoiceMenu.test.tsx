import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceMenu } from './ChoiceMenu';

const CHOICES = [
  { id: 'speed', name: 'Spindle speed' },
  { id: 'load', name: 'Spindle load' },
] as const;

describe('ChoiceMenu', () => {
  afterEach(cleanup);

  it('names the button with the label, a colon, a space and the chosen name', () => {
    render(<ChoiceMenu label="Value in the chart" choices={CHOICES} value="speed" onChoose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Value in the chart: Spindle speed' })).toBeInTheDocument();
  });

  it('tells a screen reader which item is chosen, with a space before "(chosen)"', async () => {
    render(<ChoiceMenu label="Value in the chart" choices={CHOICES} value="speed" onChoose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('menuitem', { name: 'Spindle speed (chosen)' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Spindle load' })).toBeInTheDocument();
  });

  it('gives the id of the item that the user picks', async () => {
    const onChoose = vi.fn();
    render(<ChoiceMenu label="Value in the chart" choices={CHOICES} value="speed" onChoose={onChoose} />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spindle load' }));

    expect(onChoose).toHaveBeenCalledWith('load');
  });
});
