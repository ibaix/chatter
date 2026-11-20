import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShowMoreFooter } from './ShowMoreFooter';

describe('ShowMoreFooter', () => {
  it('tells how many items show, with the noun, and shows more on a click', () => {
    const onShowMore = vi.fn();
    render(<ShowMoreFooter shownCount={10} total={25} noun="past alerts" onShowMore={onShowMore} />);

    expect(screen.getByText('Showing 10 of 25 past alerts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when all the items show', () => {
    const { container } = render(<ShowMoreFooter shownCount={25} total={25} noun="messages" onShowMore={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
