import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testMachine } from '../../test/testMachine';
import { DeleteMachineSection } from './DeleteMachineSection';

/** The boxes that the page asked the dialog provider to show */
const shownBoxes: ReactElement[] = [];
let answer = false;

vi.mock('@toolpath/ui', async importOriginal => {
  const ui = await importOriginal<typeof import('@toolpath/ui')>();
  const Dialog = Object.assign(ui.Dialog, {
    useDialog: () => ({
      confirm: async (box: ReactElement) => {
        shownBoxes.push(box);
        return answer;
      },
    }),
  });
  return { ...ui, Dialog };
});

describe('DeleteMachineSection', () => {
  beforeEach(() => {
    shownBoxes.length = 0;
    answer = false;
  });

  it('gives each opening of the box a new key, so text typed before does not stay in it', async () => {
    render(<DeleteMachineSection machine={testMachine()} onRemove={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Delete this machine' });

    fireEvent.click(button);
    await waitFor(() => expect(shownBoxes).toHaveLength(1));
    fireEvent.click(button);
    await waitFor(() => expect(shownBoxes).toHaveLength(2));

    expect(shownBoxes[0].key).not.toBeNull();
    expect(shownBoxes[1].key).not.toBe(shownBoxes[0].key);
  });

  it('cannot start a second delete while the first one runs', async () => {
    answer = true;
    let finish = () => {};
    const onRemove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<DeleteMachineSection machine={testMachine()} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete this machine' }));

    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    finish();
    expect(await screen.findByRole('button', { name: 'Delete this machine' })).toBeEnabled();
  });
});
