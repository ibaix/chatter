import { useState } from 'react';

/**
 * A long list that shows `pageSize` items at first, and `pageSize` more for each `showMore`.
 * When `resetKey` changes, for example a filter, the list starts again at `pageSize`.
 * The key is a primitive: a new object on each render would be a change on each render, and the render would never stop.
 */
export function useShownItems<Item>(items: Item[], pageSize: number, resetKey: string | number | boolean | null) {
  const [paging, setPaging] = useState({ resetKey, count: pageSize });
  let count = paging.count;
  if (!Object.is(paging.resetKey, resetKey)) {
    count = pageSize;
    setPaging({ resetKey, count });
  }
  const showMore = () => setPaging(current => ({ ...current, count: current.count + pageSize }));
  return { shown: items.slice(0, count), total: items.length, showMore };
}
