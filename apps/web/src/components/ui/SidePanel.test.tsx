import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidePanel } from './SidePanel';

function renderPanel(isClosing = false) {
  const onClose = vi.fn();
  render(
    <SidePanel label="Machine files" isClosing={isClosing} onClose={onClose} widthClassName="w-96">
      <button type="button">Close</button>
      <input aria-label="Folder" />
    </SidePanel>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Machine files' }) };
}

describe('SidePanel', () => {
  it('opens as a dialog, and puts the cursor in the first box to type in', () => {
    const { dialog } = renderPanel();

    expect(dialog).toHaveAttribute('open');
    expect(screen.getByLabelText('Folder')).toHaveFocus();
  });

  it('closes on Esc', () => {
    const { dialog, onClose } = renderPanel();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a click on the dark layer, but not on a click inside', () => {
    const { dialog, onClose } = renderPanel();
    const inside = screen.getByRole('button', { name: 'Close' });

    fireEvent.pointerDown(inside);
    fireEvent.click(inside);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('slides out while it closes', () => {
    const { dialog } = renderPanel(true);

    expect(dialog).toHaveClass('animate-slide-out-right');
  });
});
