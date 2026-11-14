import { render, renderHook } from '@testing-library/react';
import { act } from 'react';
import { useChangeCount, flashProps } from './useChangeCount';
import { LiveValue } from './motion';
import LineChart, { type ChartLayer } from './LineChart';
import { AppSettingsProvider, useAppSettings } from '../contexts/AppSettingsContext';
import { HOUR, MIN } from './chartScale';

describe('useChangeCount', () => {
  it('starts at 0 and counts only real changes', () => {
    const { result, rerender } = renderHook(({ v }) => useChangeCount(v), { initialProps: { v: '27.1' } });
    expect(result.current).toBe(0);
    rerender({ v: '27.1' });
    expect(result.current).toBe(0);
    rerender({ v: '27.2' });
    expect(result.current).toBe(1);
    rerender({ v: '27.2' });
    expect(result.current).toBe(1);
  });

  it('flash alternates a/b so each change restarts the animation', () => {
    expect(flashProps(0)).toEqual({});
    expect(flashProps(1, '#f00')['data-flash']).toBe('a');
    expect(flashProps(2)['data-flash']).toBe('b');
  });
});

describe('LiveValue', () => {
  it('shows exactly the value given, and animates only after a change', () => {
    const { container, rerender } = render(<LiveValue value="27.1" />);
    expect(container.textContent).toBe('27.1');
    expect(container.querySelector('.sg-val-in')).toBeNull();
    rerender(<LiveValue value="27.3" />);
    expect(container.textContent).toBe('27.3');
    expect(container.querySelector('.sg-val-in')).not.toBeNull();
  });
});

describe('Reduce motion setting', () => {
  it('puts sg-reduce-motion on <html> while on', () => {
    const { result } = renderHook(() => useAppSettings(), { wrapper: AppSettingsProvider });
    expect(document.documentElement.classList.contains('sg-reduce-motion')).toBe(false);
    act(() => result.current.setReduceMotion(true));
    expect(document.documentElement.classList.contains('sg-reduce-motion')).toBe(true);
    act(() => result.current.setReduceMotion(false));
    expect(document.documentElement.classList.contains('sg-reduce-motion')).toBe(false);
  });
});

describe('LineChart draw-in', () => {
  const t1 = Date.parse('2026-11-14T08:00:00Z');
  const full = { t0: t1 - 6 * HOUR, t1 };
  const pts = Array.from({ length: 30 }, (_, i) => ({ t: full.t0 + i * 12 * MIN, v: 25 + (i % 5) }));
  const layers: ChartLayer[] = [{ series: [{ name: 'z1', color: '#000', points: pts }], step: 5 * MIN, window: full }];
  const chart = (resetKey: string, at: number | null) => (
    <LineChart layers={layers} full={full} view={null} onViewChange={() => {}} minSpan={10 * MIN}
      resetKey={resetKey} updated={{ at, everyMs: 30000 }} rangeLabel="last 6h" />
  );
  const wipe = (c: HTMLElement) => c.querySelector('.sg-chart-wipe');

  it('wipes in once per load of a metric or range, never on a refresh', () => {
    const { container, rerender } = render(chart('temp|6h', null));
    expect(wipe(container)).toBeNull();                 // nothing loaded yet

    rerender(chart('temp|6h', 1000));                   // first load
    const first = wipe(container);
    expect(first).not.toBeNull();

    rerender(chart('temp|6h', 31000));                  // 30 s refresh: same element, no replay
    expect(wipe(container)).toBe(first);

    rerender(chart('temp|24h', 31000));                 // range changed, old data still shown: no replay
    expect(wipe(container)).toBe(first);
    rerender(chart('temp|24h', null));                  // new range loading
    expect(wipe(container)).toBe(first);
    rerender(chart('temp|24h', 40000));                 // new range loaded: replays
    expect(wipe(container)).not.toBe(first);
    expect(wipe(container)).not.toBeNull();
  });
});
