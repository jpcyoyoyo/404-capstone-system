import React, { useId } from 'react';

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  /** Renders a smoothed line with a gradient area fill beneath it. Default: true. */
  area?: boolean;
  /** Opacity of the gradient fill at the line (fades to 0 toward the bottom). Default: 0.32. */
  fillOpacity?: number;
  strokeWidth?: number;
}

/** Builds a smooth SVG path through points using quadratic Bézier midpoints. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    d += ` Q ${p0.x.toFixed(1)},${p0.y.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)},${last.y.toFixed(1)}`;
  return d;
}

const Sparkline: React.FC<SparklineProps> = ({
  data,
  color = '#22c55e',
  width = 64,
  height = 24,
  area = true,
  fillOpacity = 0.32,
  strokeWidth = 1.5,
}) => {
  const gradientId = `sg-spark-grad-${useId()}`;

  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.max(...data) === Math.min(...data) ? Math.min(...data) - 1 : Math.min(...data);
  const range = max - min || 1;
  const pad = 2;

  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * width,
    y: height - pad - ((v - min) / range) * (height - pad * 2),
  }));

  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {area && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={fillOpacity} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {area && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default Sparkline;
