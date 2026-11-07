import { useEffect, useMemo, useState } from 'react';
import type { HistoryResult } from '../contract/types';
import type { HistoryQuery } from '../providers/types';
import { DataPlan, Pt, RANGES, RangeId, View, finer, planFor, toPoints } from './chartScale';
import type { ChartLayer, ChartSeries } from './LineChart';

export type PerSensor = Record<string, Pt[]>;
type Fetch = (q: HistoryQuery) => Promise<HistoryResult>;
interface Loaded { window: View; plan: DataPlan; data: PerSensor; result: HistoryResult }

const load = (fetch: Fetch, base: HistoryQuery, w: View, plan: DataPlan): Promise<Loaded> =>
  fetch({ ...base, from: new Date(w.t0).toISOString(), to: new Date(w.t1).toISOString(), resolution: plan.res,
    ...(plan.res === 'raw' ? { limit: 20000 } : {}) })
    .then(result => {
      const data: PerSensor = {};
      for (const [sid, pts] of Object.entries(result.series)) data[sid] = toPoints(pts, plan.res, plan, w.t1);
      return { window: w, plan, data, result };
    });

/**
 * History for one chart: the whole range at the plan for its length, plus finer data for the
 * zoomed window (fetched 250 ms after a gesture ends). `key` names the query (metric, sensor…);
 * changing it or the range reloads and resets the zoom.
 */
export function useHistoryChart(fetch: Fetch, base: HistoryQuery, key: string, rangeId: RangeId,
  toSeries: (d: PerSensor) => ChartSeries[]) {
  const range = RANGES.find(r => r.id === rangeId) ?? RANGES[1];
  const [full, setFull] = useState<View>(() => { const now = Date.now(); return { t0: now - range.ms, t1: now }; });
  const [main, setMain] = useState<Loaded | null>(null);
  const [detail, setDetail] = useState<Loaded | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const now = Date.now();
    const w = { t0: now - range.ms, t1: now };
    setFull(w); setView(null); setDetail(null); setLoading(true); setErr(null);
    load(fetch, base, w, planFor(range.ms))
      .then(l => { if (alive) setMain(l); })
      .catch(e => { if (alive) { setErr(e instanceof Error ? e.message : 'Could not load history'); setMain(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetch, key, range.ms]);

  useEffect(() => {
    if (!view || !main) { setDetail(null); return; }
    const plan = planFor(view.t1 - view.t0);
    if (!finer(plan, main.plan)) { setDetail(null); return; }
    if (detail && detail.plan.step === plan.step && detail.window.t0 <= view.t0 && detail.window.t1 >= view.t1) return;
    let alive = true;
    const timer = setTimeout(() => {
      const pad = (view.t1 - view.t0) / 2;
      const w = { t0: Math.max(full.t0, view.t0 - pad), t1: Math.min(full.t1, view.t1 + pad) };
      setLoading(true);
      load(fetch, base, w, plan)
        .then(l => { if (alive) setDetail(l); })
        .catch(() => { /* keep showing the coarser line */ })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, main]);

  const layers: ChartLayer[] = useMemo(() => [main, detail].filter((l): l is Loaded => !!l)
    .map(l => ({ series: toSeries(l.data), step: l.plan.step, window: l.window, label: l.plan.label })), [main, detail, toSeries]);

  return { range, full, view, setView, layers, result: main?.result ?? null, plan: main?.plan ?? planFor(range.ms), loading, err };
}

/** Average several sensors into one line, bucket by bucket (the buckets are already aligned). */
export function mergeSensors(lists: Pt[][]): Pt[] {
  const by = new Map<number, { s: number; n: number; lo: number; hi: number; range: boolean }>();
  for (const pts of lists) for (const p of pts) {
    const b = by.get(p.t) ?? { s: 0, n: 0, lo: Infinity, hi: -Infinity, range: false };
    b.s += p.v; b.n += 1;
    if (p.lo !== undefined && p.hi !== undefined) { b.lo = Math.min(b.lo, p.lo); b.hi = Math.max(b.hi, p.hi); b.range = true; }
    by.set(p.t, b);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, b]) => (b.range ? { t, v: b.s / b.n, lo: b.lo, hi: b.hi } : { t, v: b.s / b.n }));
}
