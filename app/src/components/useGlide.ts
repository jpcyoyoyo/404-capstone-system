import { useLayoutEffect, useRef, useState } from 'react';

/** True when the phone asks for less motion or App Settings → Reduce motion is on. */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.classList.contains('sg-reduce-motion')) return true;
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Quick start, soft landing (the same feel as --sg-ease in motion.css). */
export const easeOut = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);

/** Values part-way from `from` to `to` (k = 0…1, already eased). */
export const mix = (from: readonly number[], to: readonly number[], k: number) => to.map((v, i) => from[i] + (v - from[i]) * k);

/**
 * Follows `target` (a few numbers, e.g. a chart's start and end time). Each time the target
 * changes, `duration()` is asked how long to take: 0 jumps straight there (pinch, drag, a new
 * metric), more glides there from whatever is on screen, so a new target in mid-glide carries on
 * smoothly from where the last one had got to. Reduced motion always jumps.
 */
export function useGlide(target: readonly number[], duration: () => number): number[] {
  const [frame, setFrame] = useState<number[] | null>(null);   // null = sitting on the target
  const key = target.join('|');
  const shown = useRef<readonly number[]>(target);               // what the last render drew
  const from = useRef<readonly number[]>(target);
  const lastKey = useRef(key);
  if (lastKey.current !== key) { from.current = shown.current; lastKey.current = key; }
  const raf = useRef(0);
  const dur = useRef(duration); dur.current = duration;
  const to = useRef(target); to.current = target;

  useLayoutEffect(() => {
    cancelAnimationFrame(raf.current);
    const a = from.current; const b = to.current;
    const ms = dur.current();
    const same = a.length === b.length && a.every((v, i) => v === b[i]);
    if (ms <= 0 || same || a.length !== b.length || reducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setFrame(null);
      return;
    }
    setFrame([...a]);                     // first frame before paint: no flash of the end state
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const k = (now - start) / ms;
      if (k >= 1) { setFrame(null); return; }
      setFrame(mix(a, b, easeOut(k)));
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [key]);

  const out = frame ?? [...target];
  shown.current = out;
  return out;
}
