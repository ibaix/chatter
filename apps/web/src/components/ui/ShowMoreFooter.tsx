import { Button } from './Button';

interface ShowMoreFooterProps {
  shownCount: number;
  total: number;
  /** The name of the items, for example "messages" */
  noun: string;
  onShowMore: () => void;
}

/** The line under a long list: "Showing 10 of 25 messages." and a Show more button. Nothing when all the items show. */
export function ShowMoreFooter({ shownCount, total, noun, onShowMore }: ShowMoreFooterProps) {
  if (shownCount >= total) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-5 py-3">
      <p className="m-0 text-xs text-zinc-300">Showing {shownCount} of {total} {noun}.</p>
      <Button size="sm" onClick={onShowMore}>Show more</Button>
    </div>
  );
}
