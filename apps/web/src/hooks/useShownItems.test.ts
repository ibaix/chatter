import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useShownItems } from './useShownItems';

const numbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe('useShownItems', () => {
  it('shows the first page of the items', () => {
    const { result } = renderHook(() => useShownItems(numbers(25), 10, 'all'));

    expect(result.current.shown).toEqual(numbers(10));
    expect(result.current.total).toBe(25);
  });

  it('shows one more page for each showMore, up to all the items', () => {
    const { result } = renderHook(() => useShownItems(numbers(25), 10, 'all'));

    act(() => result.current.showMore());
    expect(result.current.shown).toHaveLength(20);

    act(() => result.current.showMore());
    expect(result.current.shown).toHaveLength(25);
  });

  it('shows all the items when they fit in one page', () => {
    const { result } = renderHook(() => useShownItems(numbers(4), 10, 'all'));

    expect(result.current.shown).toEqual(numbers(4));
  });

  it('starts again at one page when the reset key changes', () => {
    const { result, rerender } = renderHook(({ resetKey }) => useShownItems(numbers(40), 10, resetKey), {
      initialProps: { resetKey: 'all' },
    });
    act(() => result.current.showMore());
    expect(result.current.shown).toHaveLength(20);

    rerender({ resetKey: 'phones' });

    expect(result.current.shown).toHaveLength(10);
  });

  it('keeps the shown count when only the items change', () => {
    const { result, rerender } = renderHook(({ items }) => useShownItems(items, 10, 'all'), {
      initialProps: { items: numbers(40) },
    });
    act(() => result.current.showMore());

    rerender({ items: numbers(41) });

    expect(result.current.shown).toHaveLength(20);
    expect(result.current.total).toBe(41);
  });
});
