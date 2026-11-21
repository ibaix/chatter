import { useEffect, useRef, type SyntheticEvent } from 'react';
import { useOutsideClick } from './useOutsideClick';

/**
 * The browser puts the focus on the first button, which is often the X. The first box to type in is more useful.
 * React autoFocus does not help: it runs before the dialog opens, when nothing in it can take the focus.
 */
const FIRST_BOX_TO_TYPE_IN = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

/**
 * Opens a <dialog> as a modal dialog, so the browser keeps the focus in it, and puts the focus in its first box to type in.
 * Esc and a click on the dark layer call onClose. Spread the result on the <dialog>.
 */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeOnOutsideClick = useOutsideClick(onClose);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>(FIRST_BOX_TO_TYPE_IN)?.focus();
    return () => dialog?.close();
  }, []);

  return {
    ref,
    // Esc: the parent closes the dialog, so that it can slide out first
    onCancel: (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      onClose();
    },
    ...closeOnOutsideClick,
  };
}
