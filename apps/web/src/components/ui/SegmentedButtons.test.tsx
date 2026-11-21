import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedButtons } from './SegmentedButtons';

const OPTIONS = [
  { id: 'machine', label: 'On the machine' },
  { id: 'history', label: <>Upload history <span>3</span></> },
] as const;

describe('SegmentedButtons', () => {
  afterEach(cleanup);

  it('puts the buttons in a group with the label', () => {
    render(<SegmentedButtons label="Files to show" options={OPTIONS} value="machine" onChange={vi.fn()} />);

    const group = screen.getByRole('group', { name: 'Files to show' });
    expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['On the machine', 'Upload history 3']);
  });

  it('presses only the button of the value', () => {
    render(<SegmentedButtons label="Files to show" options={OPTIONS} value="history" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'On the machine' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Upload history 3' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the id of the clicked button', () => {
    const onChange = vi.fn();
    render(<SegmentedButtons label="Files to show" options={OPTIONS} value="machine" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload history 3' }));

    expect(onChange).toHaveBeenCalledWith('history');
  });

  it('uses buttons that do not submit a form', () => {
    render(<SegmentedButtons label="Files to show" options={OPTIONS} value="machine" onChange={vi.fn()} />);

    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button');
  });
});
