import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryResult } from '../contract/types';
import type { HistoryQuery } from '../providers/types';
import { DataPlan, Pt, RANGES, RangeId, View, finer, followView, planFor, toPoints } from './chartScale';
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
 *
 * While the chart is open it reloads every `range.refresh` (30 s for 6h/24h) so new readings
 * appear. A refresh keeps the zoom: a zoomed window at the right edge follows the new data,
 * any other zoomed window stays where it is (see followView). Refreshes don't show the spinner
 * and pause while the app is in the background.
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
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Bumped on every new key/range, so a refresh that was in flight is dropped.
  const epoch = useRef(0);
  const now$ = useRef({ full, main, detail, view, base });
  now$.current = { full, main, detail, view, base };

  useEffect(() => {
    let alive = true;
    const my = ++epoch.current;
    const now = Date.now();
    const w = { t0: now - range.ms, t1: now };
    setFull(w); setView(null); setDetail(null); setLoading(true); setErr(null); setUpdatedAt(null);
    load(fetch, base, w, planFor(range.ms))
      .then(l => { if (alive && my === epoch.current) { setMain(l); setUpdatedAt(Date.now()); } })
      .catch(e => { if (alive) { setErr(e instanceof Error ? e.message : 'Could not load history'); setMain(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetch, key, range.ms]);

  // Auto-refresh: move the range to the new "now" and reload, keeping the zoom.
  useEffect(() => {
    let busy = false;
    const tick = () => {
      if (busy || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      const s = now$.current;
      const mainPlan = s.main?.plan ?? planFor(range.ms);   // no data yet (first load failed): try again
      const my = epoch.current;
      const t = Date.now();
      const w = { t0: t - range.ms, t1: t };
      // Finer data for a window that follows the right edge must be reloaded too, in the same
      // step, or the chart would drop to the coarse line until the detail fetch caught up.
      const nv = followView(s.view, s.full, w, range.minSpan);
      const plan = nv ? planFor(nv.t1 - nv.t0) : null;
      const needDetail = !!(nv && plan && s.detail && finer(plan, mainPlan) && nv.t1 > s.detail.window.t1);
      const dw = nv ? { t0: Math.max(w.t0, nv.t0 - (nv.t1 - nv.t0) / 2), t1: w.t1 } : null;
      busy = true;
      Promise.all([
        load(fetch, s.base, w, mainPlan),
        needDetail && dw && plan ? load(fetch, s.base, dw, plan).catch(() => null) : Promise.resolve(undefined),
      ]).then(([m, d]) => {
        if (my !== epoch.current) return;
        const oldFull = now$.current.full;
        setFull(w); setMain(m); setUpdatedAt(Date.now()); setErr(null);
        if (d) setDetail(d);
        setView(v => followView(v, oldFull, w, range.minSpan));
      }).catch(() => { /* keep the last data; the next tick tries again */ })
        .finally(() => { busy = false; });
    };
    const id = setInterval(tick, range.refresh);
    const onShow = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onShow); };
  }, [fetch, key, range.ms, range.refresh, range.minSpan]);

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

  return {
    range, full, view, setView, layers, result: main?.result ?? null, plan: main?.plan ?? planFor(range.ms), loading, err,
    /** When the data on screen was last loaded (ms), and a key that changes only with a new metric/range. */
    updatedAt, resetKey: `${key}|${range.id}`,
  };
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
