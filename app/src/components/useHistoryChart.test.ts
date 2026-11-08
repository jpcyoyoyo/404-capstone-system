import { act, renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { HistoryResult } from '../contract/types';
import type { HistoryQuery } from '../providers/types';
import { HOUR, MIN } from './chartScale';
import { PerSensor, useHistoryChart } from './useHistoryChart';
import type { ChartSeries } from './LineChart';

// One reading per minute up to the query's "to", so a refresh brings a newer last point.
const fetchHistory = vi.fn(async (q: HistoryQuery): Promise<HistoryResult> => {
  const to = Date.parse(q.to!); const from = Date.parse(q.from!);
  const pts = [];
  for (let t = Math.ceil(from / MIN) * MIN; t <= to; t += MIN) pts.push({ ts: new Date(t).toISOString(), value: 25, quality: 'VALID' as const });
  return { from: q.from!, to: q.to!, resolution: q.resolution ?? 'raw', series: { temp_z1_01: pts } };
});
const toSeries = (d: PerSensor): ChartSeries[] => Object.entries(d).map(([name, points]) => ({ name, color: '#000', points }));
const base = { type: 'temperature' };

describe('useHistoryChart auto-refresh', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); fetchHistory.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reloads every 30 s, moves the range forward and keeps a zoom at the right edge on the new data', async () => {
    const { result } = renderHook(() => useHistoryChart(fetchHistory, base, 'temperature', '6h', toSeries));
    await waitFor(() => expect(result.current.layers.length).toBe(1));
    const first = result.current.full;
    const zoom = { t0: first.t1 - HOUR, t1: first.t1 };
    act(() => result.current.setView(zoom));
    await waitFor(() => expect(result.current.layers.length).toBe(2));   // finer data for the zoomed hour

    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await waitFor(() => expect(result.current.full.t1).toBeGreaterThan(first.t1));
    const moved = result.current.full.t1 - first.t1;
    expect(result.current.view).not.toBeNull();
    expect(result.current.view!.t1 - result.current.view!.t0).toBe(HOUR);   // same zoom
    expect(result.current.view!.t1).toBe(zoom.t1 + moved);                  // follows the new data
    expect(result.current.layers[1].window.t1).toBe(result.current.full.t1); // finer data reloaded in the same step
    expect(result.current.layers.length).toBe(2);
  });

  it('keeps a zoomed window in the middle where it is', async () => {
    const { result } = renderHook(() => useHistoryChart(fetchHistory, base, 'temperature', '6h', toSeries));
    await waitFor(() => expect(result.current.layers.length).toBe(1));
    const first = result.current.full;
    const zoom = { t0: first.t0 + 2 * HOUR, t1: first.t0 + 3 * HOUR };
    act(() => result.current.setView(zoom));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await waitFor(() => expect(result.current.full.t1).toBeGreaterThan(first.t1));
    expect(result.current.view).toEqual(zoom);
  });

  it('a new range still resets the zoom', async () => {
    let range: '6h' | '24h' = '6h';
    const { result, rerender } = renderHook(() => useHistoryChart(fetchHistory, base, 'temperature', range, toSeries));
    await waitFor(() => expect(result.current.layers.length).toBe(1));
    act(() => result.current.setView({ t0: result.current.full.t0, t1: result.current.full.t0 + HOUR }));
    range = '24h'; rerender();
    await waitFor(() => expect(result.current.range.id).toBe('24h'));
    expect(result.current.view).toBeNull();
    expect(result.current.resetKey).toBe('temperature|24h');
  });
});
