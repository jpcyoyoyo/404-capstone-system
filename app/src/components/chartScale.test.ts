import {
  DAY, HOUR, MIN, bandPath, clampView, followView, gapFor, groupPoints, isFull, localMidnight, monotonePath, niceAxis, panBy,
  pickLabels, planFor, splitGaps, timeTicks, toPoints, zoomAt,
} from './chartScale';

// Local-time dates so the tests pass in any time zone.
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime(); // November 2026

describe('planFor', () => {
  it('picks finer data for shorter windows', () => {
    expect(planFor(30 * MIN)).toMatchObject({ res: 'raw', group: MIN });
    expect(planFor(6 * HOUR)).toMatchObject({ res: 'raw', group: 5 * MIN });
    expect(planFor(DAY)).toMatchObject({ res: '15m', group: 0 });
    expect(planFor(7 * DAY)).toMatchObject({ res: '1h', group: 0 });
    expect(planFor(30 * DAY)).toMatchObject({ res: '1h', group: 6 * HOUR });
  });
});

describe('toPoints and groupPoints', () => {
  it('drops readings that are not VALID and keeps raw readings without a range', () => {
    const pts = toPoints([
      { ts: new Date(at(6, 10, 0)).toISOString(), value: 400, quality: 'VALID' },
      { ts: new Date(at(6, 10, 1)).toISOString(), value: 9999, quality: 'INVALID' },
      { ts: new Date(at(6, 10, 2)).toISOString(), value: null, quality: 'VALID' },
      { ts: new Date(at(6, 10, 3)).toISOString(), value: 410, quality: 'WARMING' },
    ], 'raw', { res: 'raw', group: 0, step: MIN, label: '' }, Infinity);
    expect(pts).toEqual([{ t: at(6, 10, 0), v: 400 }]);
  });

  it('moves an aggregated bucket to its middle, but never past now', () => {
    const now = at(6, 17, 20);
    const pts = toPoints([
      { ts: new Date(at(6, 16, 0)).toISOString(), value: 30, min: 29, max: 31 },
      { ts: new Date(at(6, 17, 0)).toISOString(), value: 31, min: 30, max: 32 },
    ], '1h', { res: '1h', group: 0, step: HOUR, label: '' }, now);
    expect(pts.map(p => p.t)).toEqual([at(6, 16, 30), now]);
    expect(pts[0]).toMatchObject({ lo: 29, hi: 31 });
  });

  it('groups into 6-hour blocks cut at local midnight, with min and max', () => {
    const hourly = Array.from({ length: 12 }, (_, i) => ({ t: at(6, i, 30), v: i, lo: i - 1, hi: i + 1 }));
    const g = groupPoints(hourly, 6 * HOUR);
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual({ t: at(6, 3), v: 2.5, lo: -1, hi: 6 });
    expect(g[1]).toEqual({ t: at(6, 9), v: 8.5, lo: 5, hi: 12 });
  });
});

describe('splitGaps', () => {
  it('breaks the line across missing days (30d with a 9-day hole)', () => {
    const pts = [at(1, 3), at(1, 9), at(10, 3), at(10, 9), at(10, 15)].map(t => ({ t, v: 1 }));
    const segs = splitGaps(pts, gapFor(6 * HOUR));
    expect(segs.map(s => s.length)).toEqual([2, 3]);
  });
  it('keeps a lone reading as its own segment', () => {
    const pts = [at(1, 3), at(5, 3), at(5, 9)].map(t => ({ t, v: 1 }));
    expect(splitGaps(pts, gapFor(6 * HOUR)).map(s => s.length)).toEqual([1, 2]);
  });
});

describe('niceAxis', () => {
  it('fits the data with round labels', () => {
    const a = niceAxis(29.1, 34.2);
    expect(a.lo).toBeLessThanOrEqual(29.1);
    expect(a.hi).toBeGreaterThanOrEqual(34.2);
    expect(a.ticks.every(t => Number.isInteger(t))).toBe(true);
    expect(a.decimals).toBe(0);
  });
  it('copes with a flat line', () => {
    const a = niceAxis(400, 400);
    expect(a.lo).toBeLessThan(400); expect(a.hi).toBeGreaterThan(400);
  });
  it('gives decimals for small ranges', () => {
    expect(niceAxis(6.02, 6.18).decimals).toBeGreaterThan(0);
  });
});

describe('timeTicks', () => {
  it('uses hours on a 6-hour window, on round times', () => {
    const tk = timeTicks(at(6, 11, 29), at(6, 17, 29));
    expect(tk.map(k => k.label)).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  });
  it('marks midnight with the date when a window crosses it', () => {
    const tk = timeTicks(at(5, 17, 30), at(6, 17, 30));
    const mid = tk.find(k => k.major)!;
    expect(mid.t).toBe(at(6));
    expect(mid.label).toBe('Nov 6');
    expect(tk.filter(k => !k.major).every(k => /^\d\d:00$/.test(k.label))).toBe(true);
  });
  it('uses minutes when zoomed into half an hour', () => {
    const tk = timeTicks(at(6, 13, 0), at(6, 13, 30));
    expect(tk.map(k => k.label)).toEqual(['13:00', '13:05', '13:10', '13:15', '13:20', '13:25', '13:30']);
  });
  it('uses weekdays on 7 days and every 5th day on 30 days', () => {
    expect(timeTicks(at(1, 12), at(8, 12)).map(k => k.label)).toEqual(['Mon 2', 'Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8']);
    expect(timeTicks(at(7) - 30 * DAY, at(7)).map(k => k.label)).toEqual(['Oct 10', 'Oct 15', 'Oct 20', 'Oct 25', 'Oct 30', 'Nov 5']);
  });
  it('drops labels that would overlap, keeping the date', () => {
    const t0 = at(5, 17, 30); const t1 = at(6, 17, 30);
    const tk = timeTicks(t0, t1);
    const x = (t: number) => ((t - t0) / (t1 - t0)) * 200;
    const shown = pickLabels(tk, x, s => s.length * 6);
    expect(shown.has(at(6))).toBe(true);
    expect(shown.size).toBeLessThan(tk.length);
  });
});

describe('monotonePath', () => {
  it('never overshoots the points', () => {
    const d = monotonePath([[0, 10], [10, 0], [20, 0], [30, 10]]);
    const ys = [...d.matchAll(/[\d.]+,([\d.]+)/g)].map(m => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
  });
  it('draws a closed min-max band', () => {
    expect(bandPath([[0, 1], [10, 2]], [[0, 3], [10, 4]]).endsWith('Z')).toBe(true);
    expect(bandPath([[0, 1]], [[0, 3]])).toBe('');
  });
});

describe('zoom and pan', () => {
  const full = { t0: at(6, 11), t1: at(6, 17) };
  const minSpan = 30 * MIN;
  it('zooms around the point under the fingers', () => {
    const v = zoomAt(full, 2, at(6, 14), full, minSpan);
    expect(v).toEqual({ t0: at(6, 12, 30), t1: at(6, 15, 30) });
  });
  it('stops at the narrowest window and at the full range', () => {
    expect(zoomAt(full, 100, at(6, 14), full, minSpan).t1 - zoomAt(full, 100, at(6, 14), full, minSpan).t0).toBe(minSpan);
    expect(zoomAt(full, 0.1, at(6, 14), full, minSpan)).toEqual(full);
    expect(isFull(zoomAt(full, 0.5, at(6, 14), full, minSpan), full)).toBe(true);
  });
  it('cannot be swiped past either end', () => {
    const v = { t0: at(6, 12), t1: at(6, 13) };
    expect(panBy(v, 10 * HOUR, full, minSpan)).toEqual({ t0: at(6, 16), t1: at(6, 17) });
    expect(panBy(v, -10 * HOUR, full, minSpan)).toEqual({ t0: at(6, 11), t1: at(6, 12) });
    expect(clampView({ t0: at(6, 12), t1: at(6, 12, 10) }, full, minSpan).t1 - at(6, 12) >= 0).toBe(true);
  });
  it('localMidnight', () => { expect(localMidnight(at(6, 17, 29))).toBe(at(6)); });
});

describe('auto-refresh keeps the zoom (followView)', () => {
  const minSpan = 30 * MIN;
  const old = { t0: at(6, 11), t1: at(6, 17) };
  const next = { t0: at(6, 11, 1), t1: at(6, 17, 1) };   // one minute later
  it('leaves the whole range un-zoomed', () => { expect(followView(null, old, next, minSpan)).toBeNull(); });
  it('a window at the right edge follows the new readings', () => {
    expect(followView({ t0: at(6, 16), t1: at(6, 17) }, old, next, minSpan)).toEqual({ t0: at(6, 16, 1), t1: at(6, 17, 1) });
  });
  it('any other window stays on the same times and keeps its span', () => {
    expect(followView({ t0: at(6, 13), t1: at(6, 14) }, old, next, minSpan)).toEqual({ t0: at(6, 13), t1: at(6, 14) });
  });
  it('a window whose start slid out of the range is nudged in, same span', () => {
    expect(followView({ t0: at(6, 11), t1: at(6, 12) }, old, next, minSpan)).toEqual({ t0: at(6, 11, 1), t1: at(6, 12, 1) });
  });
});
