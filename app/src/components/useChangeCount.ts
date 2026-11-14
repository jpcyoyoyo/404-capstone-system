import type React from 'react';
import { useRef } from 'react';

/** Counts how many times `value` has changed since the component mounted (0 on the first render).
 *  Used to replay an animation each time a reading changes, and only then. */
export function useChangeCount(value: unknown): number {
  const ref = useRef({ v: value, n: 0 });
  if (!Object.is(ref.current.v, value)) ref.current = { v: value, n: ref.current.n + 1 };
  return ref.current.n;
}

/** Props for a tile that flashes softly in `color` when `count` goes up (see [data-flash] in motion.css). */
export function flashProps(count: number, color?: string): { 'data-flash'?: 'a' | 'b'; style?: React.CSSProperties } {
  if (!count) return {};
  return { 'data-flash': count % 2 ? 'a' : 'b', style: color ? ({ '--sg-flash': color } as React.CSSProperties) : undefined };
}
