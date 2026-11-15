import { useEffect, useState } from 'react';

/** Width at which the app switches to the desktop layout (side navigation, wider pages).
 *  Keep in step with the 992px media queries in theme/layout.css. */
export const DESKTOP_QUERY = '(min-width: 992px)';

const matches = (q: string) => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches;

/** True while the media query matches; updates when the window is resized or rotated. */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setOn(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return on;
}

/** Desktop layout (a browser window at least 992px wide). */
export const useDesktop = () => useMediaQuery(DESKTOP_QUERY);
