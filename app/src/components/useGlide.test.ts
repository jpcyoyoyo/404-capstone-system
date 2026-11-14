import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { easeOut, mix, useGlide } from './useGlide';

/** Hand-driven animation frames, so the test decides how much time passes. */
function fakeFrames() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
  return (now: number) => act(() => { const q = queue; queue = []; q.forEach(cb => cb(now)); });
}

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.classList.remove('sg-reduce-motion'); });

describe('useGlide', () => {
  it('easing starts quick, lands softly and stays inside 0…1', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(2)).toBe(1);
    expect(mix([0, 10], [10, 30], 0.5)).toEqual([5, 20]);
  });

  it('jumps straight to a new target when asked for no glide (pinch, drag, new metric)', () => {
    fakeFrames();
    const { result, rerender } = renderHook(({ t }) => useGlide(t, () => 0), { initialProps: { t: [0, 100] } });
    rerender({ t: [40, 60] });
    expect(result.current).toEqual([40, 60]);
  });

  it('glides from what is on screen to the target, then sits on it', () => {
    const frame = fakeFrames();
    const { result, rerender } = renderHook(({ t }) => useGlide(t, () => 200), { initialProps: { t: [0, 100] } });
    rerender({ t: [40, 60] });
    expect(result.current).toEqual([0, 100]);          // nothing moves before the first frame
    frame(1000); frame(1100);                           // half-way in time
    const [a, b] = result.current;
    expect(a).toBeGreaterThan(20); expect(a).toBeLessThan(40);   // past half-way in distance (eased)
    expect(b).toBeLessThan(80); expect(b).toBeGreaterThan(60);
    frame(1200);
    expect(result.current).toEqual([40, 60]);
  });

  it('a new target mid-glide carries on from where the last one had got to', () => {
    const frame = fakeFrames();
    const { result, rerender } = renderHook(({ t }) => useGlide(t, () => 200), { initialProps: { t: [0, 100] } });
    rerender({ t: [40, 60] });
    frame(1000); frame(1100);
    const mid = [...result.current];
    rerender({ t: [0, 100] });
    expect(result.current).toEqual(mid);                // no jump back to the start
    frame(2000); frame(2200);
    expect(result.current).toEqual([0, 100]);
  });

  it('never glides with Reduce motion on', () => {
    fakeFrames();
    document.documentElement.classList.add('sg-reduce-motion');
    const { result, rerender } = renderHook(({ t }) => useGlide(t, () => 200), { initialProps: { t: [0, 100] } });
    rerender({ t: [40, 60] });
    expect(result.current).toEqual([40, 60]);
  });
});
