import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Pt, ValueAxis, View, bandPath, clampView, fmtStamp, gapFor, isFull, monotonePath, niceAxis, panBy,
  pickLabels, splitGaps, timeTicks, zoomAt,
} from './chartScale';

export interface ChartSeries { name: string; color: string; points: Pt[] }
/** One set of lines: the whole range, or finer data for a zoomed window. */
export interface ChartLayer { series: ChartSeries[]; step: number; window: View; label?: string }

interface Props {
  layers: ChartLayer[];
  /** The selected range (now − 6 h → now, …). */
  full: View;
  /** The zoomed window, or null for the whole range. */
  view: View | null;
  onViewChange: (v: View | null) => void;
  /** Narrowest window the range may be zoomed to. */
  minSpan: number;
  /** "last 6h", for the zoom label. */
  rangeLabel: string;
  band?: { min: number; max: number } | null;
  height?: number;
  unit?: string;
  digits?: number;
}

const FONT = 10;
const textW = (s: string) => s.length * 5.8 + 2;
const T = 10; const B = 22;
const coarse = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

/** Last point at or before t … first after; returns the nearest one. */
function nearest(pts: Pt[], t: number): Pt | null {
  if (!pts.length) return null;
  let lo = 0; let hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; }
  const a = pts[lo]; const b = lo > 0 ? pts[lo - 1] : null;
  return b && Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a;
}

/** Points inside [t0, t1] plus one neighbour on each side, so lines run to the edges. */
function windowed(pts: Pt[], t0: number, t1: number): Pt[] {
  let i = 0; while (i < pts.length && pts[i].t < t0) i++;
  let j = pts.length - 1; while (j >= 0 && pts[j].t > t1) j--;
  return pts.slice(Math.max(0, i - 1), Math.min(pts.length, j + 2));
}

/**
 * History chart: draws at the card's real width (no stretching), time axis = the selected range,
 * value axis fitted to what is on screen, smooth monotone lines that break at gaps, a faint
 * min–max band, the target band, and the latest value. Pinch / wheel to zoom, swipe / drag to
 * move, double-tap to zoom in or back out, tap / hover for the crosshair.
 */
const LineChart: React.FC<Props> = ({ layers, full, view, onViewChange, minSpan, rangeLabel, band, height = 170, unit = '', digits = 1 }) => {
  const H = height;
  const clip = `clip${useId().replace(/:/g, '')}`;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [live, setLiveState] = useState<View | null>(null);
  const [frozen, setFrozen] = useState<ValueAxis | null>(null);
  const [cross, setCross] = useState<number | null>(null);
  const liveRef = useRef<View | null>(null);
  const setLive = (v: View | null) => { liveRef.current = v; setLiveState(v); };

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setWidth(Math.max(200, Math.round(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new range or metric starts un-zoomed.
  useEffect(() => { setLive(null); setFrozen(null); setCross(null); }, [full.t0, full.t1]);

  const cur = live ?? view ?? full;
  const span = cur.t1 - cur.t0;
  const zoomed = !isFull(cur, full);

  // The finest layer that covers the window on screen.
  const layer = useMemo(() => {
    let pick: ChartLayer | null = layers[0] ?? null;
    for (const l of layers.slice(1)) if (l.window.t0 <= cur.t0 + 1000 && l.window.t1 >= cur.t1 - 1000) pick = l;
    return pick;
  }, [layers, cur.t0, cur.t1]);

  const visible = useMemo(() => (layer?.series ?? []).map(s => ({ ...s, vis: windowed(s.points, cur.t0, cur.t1) })), [layer, cur.t0, cur.t1]);

  const axis = useMemo(() => {
    let lo = Infinity; let hi = -Infinity;
    for (const s of visible) for (const p of s.vis) {
      if (p.t < cur.t0 || p.t > cur.t1) continue;
      lo = Math.min(lo, p.lo ?? p.v, p.v); hi = Math.max(hi, p.hi ?? p.v, p.v);
    }
    if (!Number.isFinite(lo)) { lo = band?.min ?? 0; hi = band?.max ?? 1; }
    return niceAxis(lo, hi, H < 170 ? 4 : 5);
  }, [visible, cur.t0, cur.t1, band, H]);
  const ax = frozen ?? axis;

  const L = Math.max(...ax.ticks.map(v => textW(v.toFixed(ax.decimals)))) + 8;
  // Room on the right for the latest values when the lines reach "now".
  const fmtV = (v: number) => v.toFixed(digits);
  // With more than 3 lines the labels would crowd: dots only (the crosshair gives the values).
  const labelLast = visible.length <= 3;
  const lastVals = labelLast ? visible.map(s => s.points[s.points.length - 1]).filter(p => p && p.t >= cur.t0 && p.t <= cur.t1) : [];
  const R = lastVals.length ? Math.max(...lastVals.map(p => textW(fmtV(p.v)))) + 10 : 12;
  const plotW = Math.max(40, width - L - R);
  const plotH = H - T - B;
  const x = (t: number) => L + ((t - cur.t0) / span) * plotW;
  const y = (v: number) => T + (1 - (v - ax.lo) / (ax.hi - ax.lo)) * plotH;

  // Everything the pointer handlers need, always current.
  const st = useRef({ cur, full, minSpan, L, plotW, zoomed, axis: ax, onViewChange });
  st.current = { cur, full, minSpan, L, plotW, zoomed, axis: ax, onViewChange };

  const commit = () => {
    const v = liveRef.current; if (!v) return;
    setLive(null); setFrozen(null);
    st.current.onViewChange(isFull(v, st.current.full) ? null : v);
  };
  const tAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect(); const s = st.current;
    const f = Math.min(1, Math.max(0, (clientX - r.left - s.L) / s.plotW));
    return s.cur.t0 + f * (s.cur.t1 - s.cur.t0);
  };

  // ── touch and mouse ───────────────────────────────────────────────────
  const g = useRef({
    pts: new Map<number, { x: number; y: number }>(), mode: 'none' as 'none' | 'pending' | 'pan' | 'pinch' | 'press' | 'ignore',
    sx: 0, sy: 0, sv: full as View, dist: 0, anchor: 0, timer: 0 as unknown as ReturnType<typeof setTimeout>, lastTap: { t: 0, x: 0 }, mouse: false,
  });

  const onDown = (e: React.PointerEvent) => {
    const G = g.current;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    G.mouse = e.pointerType === 'mouse';
    if (G.pts.size === 2) {
      clearTimeout(G.timer);
      const [a, b] = [...G.pts.values()];
      G.mode = 'pinch'; G.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      G.sv = liveRef.current ?? st.current.cur; G.anchor = tAt((a.x + b.x) / 2);
      setFrozen(st.current.axis); setCross(null);
      for (const id of G.pts.keys()) { try { box.current?.setPointerCapture(id); } catch { /* gone */ } }
    } else if (G.pts.size === 1) {
      G.mode = 'pending'; G.sx = e.clientX; G.sy = e.clientY; G.sv = st.current.cur;
      if (!G.mouse) {
        G.timer = setTimeout(() => { if (G.mode === 'pending') { G.mode = 'press'; setCross(tAt(G.sx)); } }, 350);
      }
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const G = g.current;
    if (!G.pts.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && G.mode === 'none') setCross(tAt(e.clientX));
      return;
    }
    G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = st.current;
    if (G.mode === 'pinch' && G.pts.size >= 2) {
      const [a, b] = [...G.pts.values()];
      const factor = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / G.dist;
      const fullSpan = s.full.t1 - s.full.t0;
      const next = Math.min(fullSpan, Math.max(s.minSpan, (G.sv.t1 - G.sv.t0) / factor));
      const r = box.current!.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, ((a.x + b.x) / 2 - r.left - s.L) / s.plotW));
      const t0 = G.anchor - frac * next;
      setLive(clampView({ t0, t1: t0 + next }, s.full, s.minSpan));
      return;
    }
    const dx = e.clientX - G.sx; const dy = e.clientY - G.sy;
    if (G.mode === 'pending' && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      clearTimeout(G.timer);
      if (Math.abs(dx) > Math.abs(dy) && s.zoomed) {
        G.mode = 'pan'; setFrozen(s.axis); setCross(null);
        try { box.current?.setPointerCapture(e.pointerId); } catch { /* gone */ }
      } else G.mode = 'ignore';
    }
    if (G.mode === 'pan') setLive(panBy(G.sv, (-dx / s.plotW) * (G.sv.t1 - G.sv.t0), s.full, s.minSpan));
    else if (G.mode === 'press' || (G.mouse && G.mode === 'ignore')) setCross(tAt(e.clientX));
  };

  const onUp = (e: React.PointerEvent) => {
    const G = g.current;
    if (!G.pts.has(e.pointerId)) return;
    G.pts.delete(e.pointerId);
    clearTimeout(G.timer);
    if (G.mode === 'pinch') {
      if (G.pts.size === 1) {   // one finger left: carry on as a swipe
        const [p] = [...G.pts.values()];
        G.mode = 'pan'; G.sx = p.x; G.sy = p.y; G.sv = liveRef.current ?? st.current.cur;
        return;
      }
      commit();
    } else if (G.mode === 'pan') commit();
    else if (G.mode === 'pending' && e.type === 'pointerup') {
      const now = Date.now();
      const dbl = now - G.lastTap.t < 320 && Math.abs(e.clientX - G.lastTap.x) < 30;
      if (dbl) {
        G.lastTap = { t: 0, x: 0 }; setCross(null);
        const s = st.current;
        if (s.zoomed) { setLive(null); setFrozen(null); s.onViewChange(null); }
        else { const v = zoomAt(s.cur, 2, tAt(e.clientX), s.full, s.minSpan); s.onViewChange(isFull(v, s.full) ? null : v); }
      } else {
        G.lastTap = { t: now, x: e.clientX };
        if (!G.mouse) { const t = tAt(e.clientX); setCross(c => (c === null ? t : null)); }
      }
    }
    if (G.pts.size === 0) G.mode = 'none';
  };

  const onLeave = (e: React.PointerEvent) => { if (e.pointerType === 'mouse' && g.current.mode === 'none') setCross(null); };

  // Wheel: up/down zooms at the pointer, sideways (or Shift) moves. The page still scrolls
  // when the wheel would change nothing (fully out, or fully in).
  useEffect(() => {
    const el = box.current; if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      const s = st.current; const base = liveRef.current ?? s.cur;
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      let next: View;
      if (sideways) {
        const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        next = panBy(base, (d / s.plotW) * (base.t1 - base.t0), s.full, s.minSpan);
      } else {
        next = zoomAt(base, Math.exp(-e.deltaY * 0.002), tAt(e.clientX), s.full, s.minSpan);
      }
      if (Math.abs(next.t0 - base.t0) < 1 && Math.abs(next.t1 - base.t1) < 1) return;
      e.preventDefault();
      if (!liveRef.current) setFrozen(s.axis);
      setLive(next); setCross(null);
      clearTimeout(timer); timer = setTimeout(commit, 300);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── drawing ───────────────────────────────────────────────────────────
  const ticks = timeTicks(cur.t0, cur.t1);
  const shown = pickLabels(ticks, x, textW);
  const gap = gapFor(layer?.step ?? 0);
  const anyPoints = visible.some(s => s.vis.some(p => p.t >= cur.t0 && p.t <= cur.t1));
  const allPoints = (layers[0]?.series ?? []).flatMap(s => s.points);
  const firstT = allPoints.length ? Math.min(...allPoints.map(p => p.t)) : null;
  const hasRange = visible.some(s => s.vis.some(p => p.lo !== undefined && p.hi !== undefined && p.hi > p.lo));

  // Latest value of each line, labels pushed apart so they don't overlap.
  const latest = visible.map(s => {
    const p = s.points[s.points.length - 1];
    return p && p.t >= cur.t0 && p.t <= cur.t1 ? { s, p, ly: y(p.v) } : null;
  }).filter((a): a is { s: typeof visible[number]; p: Pt; ly: number } => !!a).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < latest.length; i++) if (latest[i].ly - latest[i - 1].ly < 11) latest[i].ly = latest[i - 1].ly + 11;

  const bandOff = band ? (band.max < ax.lo ? 'below' : band.min > ax.hi ? 'above' : null) : null;
  const crossRows = cross === null ? [] : visible.map(s => {
    const p = nearest(s.points, cross);
    return p && Math.abs(p.t - cross) <= Math.max(gap / 2, (layer?.step ?? 0)) ? { s, p } : null;
  }).filter((r): r is { s: typeof visible[number]; p: Pt } => !!r);
  const crossT = crossRows.length ? crossRows[0].p.t : cross;

  const empty = !layer || (!allPoints.length && !zoomed);

  return (
    <div>
      <div ref={box} style={{ position: 'relative', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', cursor: zoomed ? 'grab' : 'crosshair' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onLeave}
        onContextMenu={e => e.preventDefault()}>
        {empty ? (
          <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--sg-dim)' }}>No data for this range yet.</div>
        ) : (<>
        <svg width={width} height={H} style={{ display: 'block', overflow: 'visible' }} fontSize={FONT} role="img"
          aria-label={`History chart, ${fmtStamp(cur.t0, span)} to ${fmtStamp(cur.t1, span)}`}>
          <defs><clipPath id={clip}><rect x={L} y={T - 2} width={plotW} height={plotH + 4} /></clipPath></defs>

          {band && !bandOff && (
            <rect x={L} width={plotW} y={Math.max(T, y(band.max))} height={Math.max(0, Math.min(T + plotH, y(band.min)) - Math.max(T, y(band.max)))} fill="rgba(34,197,94,0.10)" />
          )}

          {ax.ticks.map(v => (
            <g key={v}>
              <line x1={L} x2={L + plotW} y1={y(v)} y2={y(v)} stroke="var(--sg-border)" strokeWidth={1} />
              <text x={L - 6} y={y(v) + 3.5} textAnchor="end" fill="var(--sg-dim)">{v.toFixed(ax.decimals)}</text>
            </g>
          ))}

          {ticks.map(tk => {
            const tx = x(tk.t); const lw = textW(tk.label);
            const anchor = tx - lw / 2 < 0 ? 'start' : tx + lw / 2 > width ? 'end' : 'middle';
            return (
              <g key={tk.t}>
                <line x1={tx} x2={tx} y1={T} y2={T + plotH} stroke={tk.major ? 'var(--sg-dim)' : 'var(--sg-border)'} strokeWidth={1} strokeOpacity={tk.major ? 0.7 : 0.6} strokeDasharray={tk.major ? '3 3' : undefined} />
                {shown.has(tk.t) && (
                  <text x={tx} y={H - 6} textAnchor={anchor} fill={tk.major ? 'var(--sg-text)' : 'var(--sg-dim)'} fontWeight={tk.major ? 700 : 400}>{tk.label}</text>
                )}
              </g>
            );
          })}

          <g clipPath={`url(#${clip})`}>
            {visible.map(s => splitGaps(s.vis, gap).map((seg, i) => {
              const ranged = seg.filter(p => p.lo !== undefined && p.hi !== undefined);
              return (
                <g key={`${s.name}-${i}`}>
                  {ranged.length >= 2 && (
                    <path d={bandPath(ranged.map(p => [x(p.t), y(p.hi!)]), ranged.map(p => [x(p.t), y(p.lo!)]))} fill={s.color} fillOpacity={visible.length > 3 ? 0.07 : 0.13} stroke="none" />
                  )}
                  {seg.length >= 2
                    ? <path d={monotonePath(seg.map(p => [x(p.t), y(p.v)]))} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
                    : <circle cx={x(seg[0].t)} cy={y(seg[0].v)} r={2.6} fill={s.color} />}
                </g>
              );
            }))}
          </g>

          {latest.map(({ s, p, ly }) => (
            <g key={`last-${s.name}`}>
              <circle cx={x(p.t)} cy={y(p.v)} r={3.6} fill={s.color} stroke="var(--sg-card)" strokeWidth={1.5} />
              {labelLast && <text x={x(p.t) + 6} y={ly + 3.5} textAnchor="start" fontWeight={700} fill={s.color} stroke="var(--sg-card)" strokeWidth={3} paintOrder="stroke">{fmtV(p.v)}</text>}
            </g>
          ))}

          {bandOff && band && (
            <text x={L + plotW - 2} y={bandOff === 'below' ? T + plotH - 4 : T + 9} textAnchor="end" fill="#16a34a">
              {bandOff === 'below' ? '↓' : '↑'} target {band.min}–{band.max}{unit} {bandOff}
            </text>
          )}
          {!anyPoints && (
            <text x={L + plotW / 2} y={T + plotH / 2} textAnchor="middle" fill="var(--sg-dim)" fontSize={12}>No readings in this window</text>
          )}

          {crossT !== null && crossT >= cur.t0 && crossT <= cur.t1 && (
            <g pointerEvents="none">
              <line x1={x(crossT)} x2={x(crossT)} y1={T} y2={T + plotH} stroke="var(--sg-text)" strokeOpacity={0.45} strokeWidth={1} />
              {crossRows.map(({ s, p }) => <circle key={s.name} cx={x(p.t)} cy={y(p.v)} r={3.6} fill="var(--sg-card)" stroke={s.color} strokeWidth={2} />)}
            </g>
          )}
        </svg>

        {crossT !== null && crossT >= cur.t0 && crossT <= cur.t1 && (
          <div style={{
            position: 'absolute', top: 2, pointerEvents: 'none', background: 'var(--sg-card)', border: '1px solid var(--sg-border)',
            borderRadius: 8, padding: '5px 8px', fontSize: 11, color: 'var(--sg-text)', boxShadow: '0 2px 8px rgba(0,0,0,0.12)', whiteSpace: 'nowrap',
            ...(x(crossT) < width / 2 ? { left: x(crossT) + 10 } : { right: width - x(crossT) + 10 }),
          }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{fmtStamp(crossT, span > 0 ? Math.max(span, 3 * 864e5) : span)}</div>
            {crossRows.length === 0 && <div style={{ color: 'var(--sg-dim)' }}>No reading here</div>}
            {crossRows.map(({ s, p }) => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: s.color, display: 'inline-block' }} />
                <span style={{ color: 'var(--sg-muted)' }}>{s.name}</span>
                <b>{fmtV(p.v)}{unit}</b>
                {p.lo !== undefined && p.hi !== undefined && p.hi > p.lo && <span style={{ color: 'var(--sg-dim)' }}>({fmtV(p.lo)}–{fmtV(p.hi)})</span>}
              </div>
            ))}
          </div>
        )}
        </>)}
      </div>

      {zoomed && !empty && (
        <div style={{ marginTop: 6 }}>
          <div style={{ marginLeft: L, width: plotW, height: 4, borderRadius: 2, background: 'var(--sg-elevated)', position: 'relative' }}>
            <div style={{
              position: 'absolute', top: 0, bottom: 0, borderRadius: 2, background: 'var(--sg-green)',
              left: `${((cur.t0 - full.t0) / (full.t1 - full.t0)) * 100}%`, width: `${Math.max(2, (span / (full.t1 - full.t0)) * 100)}%`,
            }} />
          </div>
          <div className="sg-row-between" style={{ marginTop: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{fmtStamp(cur.t0, span)} – {fmtStamp(cur.t1, span)} of {rangeLabel}</span>
            <span className="sg-filter-pill" role="button" style={{ padding: '3px 10px', fontSize: 11 }}
              onClick={() => { setLive(null); setFrozen(null); onViewChange(null); }}>Reset zoom</span>
          </div>
        </div>
      )}

      {!empty && <>
      <div className="sg-row sg-gap-12" style={{ flexWrap: 'wrap', marginTop: 6, rowGap: 2 }}>
        {(layer?.series ?? []).map(s => (
          <span key={s.name} className="sg-row sg-gap-4" style={{ fontSize: 11, color: 'var(--sg-muted)' }}>
            <span style={{ width: 12, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} /> {s.name}
          </span>
        ))}
        {band && <span style={{ fontSize: 11, color: 'var(--sg-dim)' }}>shaded: target {band.min}–{band.max}{unit}</span>}
        {hasRange && <span style={{ fontSize: 11, color: 'var(--sg-dim)' }}>light band: lowest–highest reading</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 3 }}>
        {layer?.label ? `Each point: ${layer.label}. ` : ''}
        {!zoomed && firstT !== null && firstT > full.t0 + (full.t1 - full.t0) * 0.05 ? `Data from ${fmtStamp(firstT, Math.max(full.t1 - full.t0, 3 * 864e5))}. ` : ''}
        {zoomed ? (coarse() ? 'Swipe to move, double-tap to zoom out.' : 'Drag to move, double-click to zoom out.') : (coarse() ? 'Pinch or double-tap to zoom.' : 'Scroll or double-click to zoom.')}
      </div>
      </>}
    </div>
  );
};

export default LineChart;
