import { useCallback, useSyncExternalStore } from 'react';

export default function useIsMobile(breakpoint = 768) {
  const subscribe = useCallback((cb) => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    mql.addEventListener('change', cb);
    return () => mql.removeEventListener('change', cb);
  }, [breakpoint]);
  const getSnapshot = useCallback(() => window.innerWidth < breakpoint, [breakpoint]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
