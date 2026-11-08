/**
 * Pure helpers for the history chart (LineChart): data plans per window, grouping, gaps,
 * time and value ticks, the monotone curve, and zoom / pan arithmetic.
 * All calendar work is in the device's local time (Asia/Manila on our phones and the Pi).
 */
import type { HistoryPoint } from '../contract/types';

export const MIN = 6e4;
export const HOUR = 36e5;
export const DAY = 864e5;

export interface Pt { t: number; v: number; lo?: number; hi?: number }
export interface View { t0: number; t1: number }
export type Resolution = 'raw' | '15m' | '1h' | '1d';

/** The ranges offered by the pills, and how far each may be zoomed in. */
/** `refresh`: how often an open chart reloads (the nodes publish every 30 s). */
export const RANGES = [
  { id: '6h', ms: 6 * HOUR, minSpan: 30 * MIN, refresh: 30_000 },
  { id: '24h', ms: DAY, minSpan: HOUR, refresh: 30_000 },
  { id: '7d', ms: 7 * DAY, minSpan: 6 * HOUR, refresh: 2 * MIN },
  { id: '30d', ms: 30 * DAY, minSpan: DAY, refresh: 5 * MIN },
] as const;
export type RangeId = typeof RANGES[number]['id'];

const RES_MS: Record<Resolution, number> = { raw: 0, '15m': 15 * MIN, '1h': HOUR, '1d': DAY };

export interface DataPlan {
  /** Resolution asked from the controller. */
  res: Resolution;
  /** Width the app groups points into (0 = keep as received). */
  group: number;
  /** Nominal spacing of the points shown, used to find gaps. */
  step: number;
  /** Plain words for the footnote. */
  label: string;
}

/** What to fetch and how to group it for a window of `span` ms. */
export function planFor(span: number): DataPlan {
  const slack = 1.02;
  if (span <= 2 * HOUR * slack) return { res: 'raw', group: MIN, step: MIN, label: 'each reading (1-minute steps)' };
  if (span <= 6 * HOUR * slack) return { res: 'raw', group: 5 * MIN, step: 5 * MIN, label: '5-minute averages' };
  if (span <= 2 * DAY * slack) return { res: '15m', group: 0, step: 15 * MIN, label: '15-minute averages' };
  if (span <= 8 * DAY * slack) return { res: '1h', group: 0, step: HOUR, label: 'hourly averages' };
  return { res: '1h', group: 6 * HOUR, step: 6 * HOUR, label: '6-hour averages' };
}

/** True when plan `a` shows finer detail than plan `b`. */
export const finer = (a: DataPlan, b: DataPlan) => a.step < b.step;

/** Local midnight at or before t. */
export function localMidnight(t: number): number {
  const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime();
}

/**
 * Turn one sensor's history into chart points: VALID values only, aggregated buckets moved to
 * their middle (the controller stamps a bucket with its start), then grouped into `plan.group`
 * buckets aligned to local midnight. Groups carry the lowest and highest reading (lo / hi),
 * except 1-minute groups of raw readings, which are single readings.
 */
export function toPoints(pts: HistoryPoint[], res: Resolution, plan: DataPlan, now: number): Pt[] {
  const half = RES_MS[res] / 2;
  const clean: Pt[] = [];
  for (const p of pts) {
    if (p.value === null || p.value === undefined || !Number.isFinite(p.value)) continue;
    if (p.quality !== undefined && p.quality !== 'VALID') continue;
    const t = Math.min(Date.parse(p.ts) + half, now);
    clean.push(res === 'raw' ? { t, v: p.value } : { t, v: p.value, lo: p.min ?? p.value, hi: p.max ?? p.value });
  }
  clean.sort((a, b) => a.t - b.t);
  return plan.group > 0 ? groupPoints(clean, plan.group, now, plan.group > MIN) : clean;
}

/** Average points into fixed buckets aligned to local midnight; each point sits at its bucket's middle. */
export function groupPoints(pts: Pt[], width: number, now = Infinity, withRange = true): Pt[] {
  const out: Pt[] = [];
  let key = NaN; let sum = 0; let n = 0; let lo = Infinity; let hi = -Infinity; let start = 0;
  const flush = () => {
    if (!n) return;
    const p: Pt = { t: Math.min(start + width / 2, now), v: sum / n };
    if (withRange) { p.lo = lo; p.hi = hi; }
    out.push(p);
  };
  for (const p of pts) {
    const m = localMidnight(p.t);
    const k = m + Math.floor((p.t - m) / width) * width;
    if (k !== key) { flush(); key = k; start = k; sum = 0; n = 0; lo = Infinity; hi = -Infinity; }
    sum += p.v; n += 1;
    lo = Math.min(lo, p.lo ?? p.v); hi = Math.max(hi, p.hi ?? p.v);
  }
  flush();
  return out;
}

/** Split points wherever the time between two neighbours is more than `maxGap`. */
export function splitGaps(pts: Pt[], maxGap: number): Pt[][] {
  const segs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of pts) {
    if (cur.length && p.t - cur[cur.length - 1].t > maxGap) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** The gap allowed before a line breaks: about three points' worth of time. */
export const gapFor = (step: number) => 3.5 * Math.max(step, MIN);

// ── value axis ──────────────────────────────────────────────────────────

export interface ValueAxis { lo: number; hi: number; ticks: number[]; decimals: number }

/** A value axis that fits [min, max] with round tick labels (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceAxis(min: number, max: number, count = 4): ValueAxis {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (max - min < 1e-9) { const d = Math.abs(min) * 0.05 || 1; min -= d; max += d; }
  const pad = (max - min) * 0.06;
  min -= pad; max += pad;
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw * 0.999) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { lo, hi, ticks, decimals };
}

// ── time axis ───────────────────────────────────────────────────────────

export interface TimeTick { t: number; label: string; major: boolean; n: number }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');
export const fmtClock = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
export const fmtDay = (t: number) => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
export const fmtWeekday = (t: number) => { const d = new Date(t); return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`; };
export const fmtStamp = (t: number, span: number) => span > 2 * DAY ? `${fmtDay(t)}, ${fmtClock(t)}` : fmtClock(t);

/** Gridline spacing for a window of `span` ms (minutes, hours or days). */
export function tickStep(span: number): number {
  if (span <= 40 * MIN) return 5 * MIN;
  if (span <= HOUR * 1.02) return 10 * MIN;
  if (span <= 2 * HOUR * 1.02) return 15 * MIN;
  if (span <= 12 * HOUR * 1.02) return HOUR;
  if (span <= DAY * 1.02) return 3 * HOUR;
  if (span <= 2 * DAY * 1.02) return 6 * HOUR;
  if (span <= 10 * DAY * 1.02) return DAY;
  return 5 * DAY;
}

/**
 * Gridlines for [t0, t1]: sub-day steps fall on round local times (13:00, 13:15) and every local
 * midnight is a major line labelled with its date; day steps fall on local midnights (Mon 2), and
 * 5-day steps on the 5th, 10th, 15th… of the month (Oct 10).
 */
export function timeTicks(t0: number, t1: number): TimeTick[] {
  const step = tickStep(t1 - t0);
  const out: TimeTick[] = [];
  if (step < DAY) {
    let day = localMidnight(t0);
    while (day <= t1) {
      const next = localMidnight(day + DAY + 2 * HOUR);
      for (let i = 0, t = day; t < next; i++, t = day + i * step) {
        if (t < t0 || t > t1) continue;
        out.push({ t, major: i === 0, n: i, label: i === 0 ? fmtDay(t) : fmtClock(t) });
      }
      day = next;
    }
    return out;
  }
  for (let day = localMidnight(t0); day <= t1; day = localMidnight(day + DAY + 2 * HOUR)) {
    if (day < t0) continue;
    const d = new Date(day);
    if (step === DAY) out.push({ t: day, major: false, n: Math.round(day / DAY), label: fmtWeekday(day) });
    else if (d.getDate() % 5 === 0 && d.getDate() <= 30) out.push({ t: day, major: false, n: d.getDate() / 5, label: fmtDay(day) });
  }
  return out;
}

/**
 * Which tick labels to draw so none overlap: dates at midnight first, then the others on a
 * regular every-k-th pattern. `x` maps time to pixels; `width` estimates a label's width.
 */
export function pickLabels(ticks: TimeTick[], x: (t: number) => number, width: (s: string) => number, gap = 8): Set<number> {
  const placed: [number, number][] = [];
  const fits = (a: number, b: number) => placed.every(([p, q]) => b + gap <= p || a >= q + gap);
  const shown = new Set<number>();
  const span = (tk: TimeTick): [number, number] => { const w = width(tk.label); const c = x(tk.t); return [c - w / 2, c + w / 2]; };
  for (const tk of ticks.filter(k => k.major)) {
    const [a, b] = span(tk); if (fits(a, b)) { placed.push([a, b]); shown.add(tk.t); }
  }
  const minor = ticks.filter(k => !k.major);
  if (minor.length < 2) { for (const tk of minor) { const [a, b] = span(tk); if (fits(a, b)) { placed.push([a, b]); shown.add(tk.t); } } return shown; }
  const px = Math.abs(x(minor[1].t) - x(minor[0].t)) || 1;
  const widest = Math.max(...minor.map(k => width(k.label)));
  let k = Math.max(1, Math.ceil((widest + gap) / px));
  if (k > 1) k = [2, 3, 4, 6, 8, 12].find(c => c >= k) ?? k;
  for (const tk of minor) {
    if (tk.n % k !== 0) continue;
    const [a, b] = span(tk); if (fits(a, b)) { placed.push([a, b]); shown.add(tk.t); }
  }
  return shown;
}

// ── curve ───────────────────────────────────────────────────────────────

/**
 * Monotone cubic path through every point (Fritsch–Carlson, as d3.curveMonotoneX): smooth, and
 * never higher or lower than the neighbouring points, so it cannot invent a peak.
 */
export function monotonePath(xy: [number, number][], move = true): string {
  const n = xy.length;
  if (n === 0) return '';
  const f = (v: number) => v.toFixed(1);
  let d = `${move ? 'M' : 'L'}${f(xy[0][0])},${f(xy[0][1])}`;
  if (n === 1) return d;
  if (n === 2) return `${d}L${f(xy[1][0])},${f(xy[1][1])}`;
  const dx: number[] = []; const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xy[i + 1][0] - xy[i][0]);
    m.push(dx[i] === 0 ? 0 : (xy[i + 1][1] - xy[i][1]) / dx[i]);
  }
  const tan: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) tan.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1]; const w2 = dx[i] + 2 * dx[i - 1];
      tan.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  tan.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(xy[i][0] + h)},${f(xy[i][1] + h * tan[i])} ${f(xy[i + 1][0] - h)},${f(xy[i + 1][1] - h * tan[i + 1])} ${f(xy[i + 1][0])},${f(xy[i + 1][1])}`;
  }
  return d;
}

/** Closed area between the hi and lo curves of a segment. */
export function bandPath(top: [number, number][], bottom: [number, number][]): string {
  if (top.length < 2) return '';
  return `${monotonePath(top)}${monotonePath([...bottom].reverse(), false)}Z`;
}

// ── zoom and pan ────────────────────────────────────────────────────────

/** Keep a view inside the full range and no narrower than minSpan. */
export function clampView(v: View, full: View, minSpan: number): View {
  const fullSpan = full.t1 - full.t0;
  const span = Math.min(fullSpan, Math.max(minSpan, v.t1 - v.t0));
  let t0 = v.t0;
  if (v.t1 - v.t0 !== span) t0 = (v.t0 + v.t1) / 2 - span / 2;
  t0 = Math.max(full.t0, Math.min(full.t1 - span, t0));
  return { t0, t1: t0 + span };
}

/** Zoom by `factor` (>1 = in) keeping time `anchor` at the same place on screen. */
export function zoomAt(v: View, factor: number, anchor: number, full: View, minSpan: number): View {
  const span = v.t1 - v.t0;
  const frac = span > 0 ? (anchor - v.t0) / span : 0.5;
  const fullSpan = full.t1 - full.t0;
  const next = Math.min(fullSpan, Math.max(minSpan, span / factor));
  const t0 = anchor - frac * next;
  const out = clampView({ t0, t1: t0 + next }, full, minSpan);
  return out;
}

/** Slide a view by dt ms, stopping at the ends of the range. */
export const panBy = (v: View, dt: number, full: View, minSpan: number): View =>
  clampView({ t0: v.t0 + dt, t1: v.t1 + dt }, full, minSpan);

/** True when the view shows (nearly) the whole range. */
export const isFull = (v: View, full: View) => (v.t1 - v.t0) >= (full.t1 - full.t0) * 0.999;

/**
 * Where a zoomed window goes when the range moves forward to a newer "now" (auto-refresh).
 * A window that reached the old right edge follows the new data; any other window stays on the
 * same times (only nudged if its start has slid out of the range). The span never changes.
 */
export function followView(v: View | null, oldFull: View, newFull: View, minSpan: number): View | null {
  if (!v) return null;
  const span = v.t1 - v.t0;
  const atEnd = oldFull.t1 - v.t1 <= Math.max(1000, span * 0.02);
  const shift = atEnd ? newFull.t1 - oldFull.t1 : 0;
  const next = clampView({ t0: v.t0 + shift, t1: v.t1 + shift }, newFull, minSpan);
  return isFull(next, newFull) ? null : next;
}
