// One row of a settings card (App Settings): label and hint on the left, the control on the right.
import React from 'react';

/** One setting: label (and hint) on the left, its control on the right. A `wide` control (a row of
 *  choices) moves under its label when the card is narrow (theme/layout.css), so a phone with large
 *  system text never pushes a choice off the screen. */
export const SettingRow: React.FC<{ label: string; sub?: string; wide?: boolean; children: React.ReactNode }> = ({ label, sub, wide, children }) => (
  <div className="sg-setting">
    <div className={`sg-setting-row${wide ? ' wide' : ''}`}>
      <div className="sg-setting-text">
        <div style={{ fontSize: 14, color: 'var(--sg-text)', fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div className="sg-setting-ctl">{children}</div>
    </div>
  </div>
);

export const ChipGroup = <T extends string>({
  options, value, onChange, colors, labels, disabled,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  colors?: Record<T, string>;
  /** Text to show instead of the option's own name. */
  labels?: Record<T, string>;
  disabled?: boolean;
}) => (
  <div className="sg-chip-group" role="radiogroup">
    {options.map(o => {
      const active = value === o;
      const accent = colors ? colors[o] : '#22c55e';
      return (
        <button key={o} type="button" role="radio" aria-checked={active} disabled={disabled} onClick={() => onChange(o)} style={{
          background: active ? `${accent}20` : 'var(--sg-elevated)',
          border: `1px solid ${active ? accent + '60' : 'var(--sg-border)'}`,
          borderRadius: 20, padding: '4px 11px', fontSize: 12, cursor: 'pointer',
          color: active ? accent : 'var(--sg-muted)', fontWeight: active ? 600 : 400, textTransform: labels ? 'none' : 'capitalize',
          opacity: disabled ? 0.5 : 1,
        }}>{labels ? labels[o] : o}</button>
      );
    })}
  </div>
);
