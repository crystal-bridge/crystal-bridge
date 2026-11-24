import { useEffect, useState } from 'react';

/** Tailwind's md: below it is a phone, as the rest of the app splits it. */
export const WIDE_QUERY = '(min-width: 768px)';

/** Whether a media query matches now, following it as it changes. Without `matchMedia` (a test), it matches. */
export function useMatches(query: string): boolean {
  const matches = () => typeof window.matchMedia !== 'function' || window.matchMedia(query).matches;
  const [now, setNow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setNow(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return now;
}

/** A screen at least Tailwind's md wide: not a phone. */
export const useWide = () => useMatches(WIDE_QUERY);
