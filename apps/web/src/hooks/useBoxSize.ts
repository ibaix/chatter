import { useEffect, useState } from 'react';

/**
 * The size of an element, kept current when the page changes size.
 * `ref` is a callback ref, so the size is measured also when the element shows after a first render
 * without it (for example after a "Loading…" text).
 */
export function useBoxSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref: setElement, ...size };
}
