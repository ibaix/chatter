import { useEffect, useRef } from 'react';

/**
 * Runs `refresh` every `intervalMs` while the page is in view, and at once when the page shows again.
 * It takes no action while the page is hidden, and it stops on unmount. It always runs the newest `refresh`.
 */
export function useRefreshWhileVisible(refresh: () => unknown, intervalMs: number) {
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void latestRefresh.current();
    };
    const timer = setInterval(refreshIfVisible, intervalMs);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [intervalMs]);
}
