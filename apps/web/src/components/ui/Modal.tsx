import type { ReactNode } from 'react';
import { useModalDialog } from './useModalDialog';

interface ModalProps {
  /** The name of the box for screen readers, such as "Add a machine" */
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A box in the middle of the screen, over a dark layer. The page behind it does not react.
 * It is a modal dialog, so the browser keeps the focus in it. Esc and a click on the dark layer close it.
 * When it opens, the focus goes to the first box to type in.
 * The dialog fills the screen and scrolls, and the box sits in it. So only the screen edge cuts off
 * what sticks out of the box, such as a hover box.
 */
export function Modal({ label, onClose, children }: ModalProps) {
  const dialogProps = useModalDialog(onClose);

  return (
    <dialog
      {...dialogProps}
      aria-label={label}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-transparent p-4 text-zinc-50 outline-none open:flex backdrop:bg-black/60 animate-fade-in backdrop:animate-fade-in motion-reduce:animate-none motion-reduce:backdrop:animate-none"
    >
      <div className="m-auto w-full max-w-3xl">{children}</div>
    </dialog>
  );
}
