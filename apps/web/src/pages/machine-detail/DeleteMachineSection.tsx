import { Dialog } from '@toolpath/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { TextInput } from '../../components/ui/fields';
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
  const [isDeleting, setIsDeleting] = useState(false);
  // The dialog provider keeps the last box. A new key for each opening starts the box again with an empty field.
  const openings = useRef(0);

  const remove = async () => {
    openings.current += 1;
    if (!await confirm(<DeleteMachineDialog key={openings.current} machineName={machine.name} />)) return;
    setIsDeleting(true);
    try {
      await onRemove();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="m-0 text-[0.8125rem] text-zinc-200">Chatter stops reading this machine and deletes its spindle speed history.</p>
      <Button variant="danger" onClick={remove} disabled={isDeleting}>{isDeleting ? 'Deleting…' : 'Delete this machine'}</Button>
    </div>
  );
}

/** The confirmation box. Its Delete button works only when the box has the word "delete". */
function DeleteMachineDialog({ machineName }: { machineName: string }) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const titleId = useId();
  const isConfirmed = typed.trim().toLowerCase() === CONFIRM_WORD;

  // The dialog of @toolpath/ui does not link its title to the box, so a screen reader says only "alert dialog"
  useEffect(() => {
    document.getElementById(titleId)?.closest('[role="alertdialog"]')?.setAttribute('aria-labelledby', titleId);
  }, [titleId]);

  return (
    <Dialog variant="danger">
      <Dialog.Title id={titleId}>Delete {machineName}?</Dialog.Title>
      <Dialog.Message>
        Chatter stops reading this machine and deletes its spindle speed history. You cannot undo this.
      </Dialog.Message>
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <label htmlFor={inputId} className="text-xs font-semibold text-zinc-200">Type DELETE to enable the Delete button</label>
        <TextInput id={inputId} mono value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      <Dialog.Actions>
        <Dialog.Dismiss>Keep the machine</Dialog.Dismiss>
        <Dialog.Confirm disabled={!isConfirmed}>Delete the machine</Dialog.Confirm>
      </Dialog.Actions>
    </Dialog>
  );
}
