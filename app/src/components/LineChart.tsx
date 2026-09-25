import React from 'react';

export interface Series { name: string; color: string; points: { t: number; v: number | null }[] }

interface Props {
  series: Series[];
  band?: { min: number; max: number } | null;
  height?: number;
  unit?: string;
  digits?: number;
}

/** Multi-series time chart with the threshold band shaded. Scales to its container width. */
const LineChart: React.FC<Props> = ({ series, band, height = 160, unit = '', digits = 1 }) => {
  const W = 320; const H = height; const L = 34; const R = 6; const T = 8; const B = 20;
  const all = series.flatMap(s => s.points).filter(p => p.v !== null) as { t: number; v: number }[];
  if (all.length < 2) {
    return <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--sg-dim)' }}>No data for this range yet.</div>;
  }
  const t0 = Math.min(...all.map(p => p.t)); const t1 = Math.max(...all.map(p => p.t));
  if (t1 === t0) {
    return <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--sg-dim)' }}>Not enough history yet — check back in a few minutes.</div>;
  }
  let lo = Math.min(...all.map(p => p.v)); let hi = Math.max(...all.map(p => p.v));
  if (band) { lo = Math.min(lo, band.min); hi = Math.max(hi, band.max); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const span = t1 - t0;
  const fmtT = (t: number) => {
    const d = new Date(t);
    return span > 2 * 864e5 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const path = (pts: Series['points']) => {
    let d = ''; let pen = false;
    for (const p of pts) {
      if (p.v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
        {band && <rect x={L} width={W - L - R} y={y(band.max)} height={Math.max(0, y(band.min) - y(band.max))} fill="rgba(34,197,94,0.10)" />}
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--sg-border)" strokeWidth={0.5} />
            <text x={L - 4} y={y(v) + 3} fontSize={8} textAnchor="end" fill="var(--sg-dim)">{v.toFixed(digits)}</text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} fontSize={8} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fill="var(--sg-dim)">{fmtT(t)}</text>
        ))}
        {series.map(s => <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="sg-row sg-gap-12" style={{ flexWrap: 'wrap', marginTop: 4 }}>
        {series.map(s => (
          <span key={s.name} className="sg-row sg-gap-4" style={{ fontSize: 11, color: 'var(--sg-muted)' }}>
            <span style={{ width: 10, height: 2, background: s.color, display: 'inline-block' }} /> {s.name}
          </span>
        ))}
        {band && <span style={{ fontSize: 11, color: 'var(--sg-dim)' }}>shaded: target {band.min}–{band.max}{unit}</span>}
      </div>
    </div>
  );
};

export default LineChart;
