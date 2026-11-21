import { Dialog } from '@toolpath/ui';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import type { Machine } from '../../types';

/** The word that the admin types before Chatter deletes a machine. Upper and lower case are the same. */
const CONFIRM_WORD = 'delete';

interface DeleteMachineSectionProps {
  machine: Machine;
  onRemove: () => Promise<void>;
}

/** Delete the machine, after the admin types "delete" in the confirmation box */
export function DeleteMachineSection({ machine, onRemove }: DeleteMachineSectionProps) {
  const { confirm } = Dialog.useDialog();

  const remove = async () => {
    if (await confirm(<DeleteMachineDialog machineName={machine.name} />)) await onRemove();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="m-0 text-[0.8125rem] text-zinc-200">Chatter stops reading this machine and deletes its spindle speed history.</p>
      <Button variant="danger" onClick={remove}>Delete machine</Button>
    </div>
  );
}

/** The confirmation box. Its Delete button works only when the box has the word "delete". */
function DeleteMachineDialog({ machineName }: { machineName: string }) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const isConfirmed = typed.trim().toLowerCase() === CONFIRM_WORD;
  return (
    <Dialog variant="danger">
      <Dialog.Title>Delete {machineName}?</Dialog.Title>
      <Dialog.Message>
        Chatter stops reading this machine and deletes its spindle speed history. You cannot undo this.
      </Dialog.Message>
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <label htmlFor={inputId} className="text-xs font-semibold text-zinc-200">Type {CONFIRM_WORD} to delete the machine</label>
        <input
          id={inputId}
          value={typed}
          onChange={event => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100"
        />
      </div>
      <Dialog.Actions>
        <Dialog.Dismiss>Keep the machine</Dialog.Dismiss>
        <Dialog.Confirm disabled={!isConfirmed}>Delete the machine</Dialog.Confirm>
      </Dialog.Actions>
    </Dialog>
  );
}
