import React from 'react';
import { flashProps, useChangeCount } from './useChangeCount';

interface LiveValueProps {
  /** What is shown, already formatted; a change of this text replays the slide-in. */
  value: string;
  className?: string;
  style?: React.CSSProperties;
}

/** A reading that slides into place when it changes. It never counts through in-between
 *  numbers: only values that were actually read are ever shown. */
export const LiveValue: React.FC<LiveValueProps> = ({ value, className, style }) => {
  const n = useChangeCount(value);
  return (
    <span key={n} className={`sg-live-value${n ? ' sg-val-in' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {value}
    </span>
  );
};

/** Shimmering placeholder shown while data loads. */
export const Skeleton: React.FC<{ w?: number | string; h?: number; r?: number; style?: React.CSSProperties }> = ({ w = '100%', h = 12, r = 6, style }) => (
  <span className="sg-skel" aria-hidden="true" style={{ width: w, height: h, borderRadius: r, ...style }} />
);

/** A few placeholder rows for a list that is loading. */
export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 0' }}>
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Skeleton w={28} h={28} r={8} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Skeleton w={`${70 - i * 12}%`} h={11} />
          <Skeleton w={`${45 - i * 6}%`} h={9} />
        </div>
      </div>
    ))}
  </div>
);

interface FlashBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The displayed reading; the box flashes softly each time this text changes. */
  watch: string;
  /** Flash colour, normally the reading's status colour. */
  color?: string;
}

/** A tile that flashes once in its status colour when its reading changes. */
export const FlashBox: React.FC<FlashBoxProps> = ({ watch, color, style, children, ...rest }) => {
  const n = useChangeCount(watch);
  const f = flashProps(n, color);
  return <div {...rest} data-flash={f['data-flash']} style={{ ...style, ...f.style }}>{children}</div>;
};
