import { useEffect, useState } from 'react';
import type { Mode } from '../lib/colors';

/**
 * Tracks the effective colour mode so chart fills can be picked from the
 * matching palette column. Dark mode is a selected set of steps, not an
 * automatic inversion, so the charts need to know which one is showing.
 */
export function useColorMode(): Mode {
  const [mode, setMode] = useState<Mode>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setMode(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return mode;
}
