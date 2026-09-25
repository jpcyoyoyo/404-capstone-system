import React, { useState } from 'react';
import { IonPage, IonContent, IonButton, IonToggle } from '@ionic/react';
import PersistentHeader from '../components/PersistentHeader';
import {
  useAppSettings, ACCENT_COLORS, Theme, Accent, FontSize, Density, Units,
} from '../contexts/AppSettingsContext';
import { useConnection } from '../contexts/ConnectionContext';
import { useAuth } from '../contexts/AuthContext';
import { useHistory } from 'react-router-dom';
import ConnectionEditor from '../components/ConnectionEditor';
import { useGreenhouse } from '../providers/GreenhouseProvider';

const accentColors = ACCENT_COLORS;

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="sg-section-title" style={{ marginTop: 4, marginBottom: 10 }}>{children}</div>
);

const SettingRow: React.FC<{ label: string; sub?: string; children: React.ReactNode }> = ({ label, sub, children }) => (
  <div className="sg-row-between" style={{ padding: '11px 0', borderBottom: '1px solid var(--sg-border)' }}>
    <div>
      <div style={{ fontSize: 14, color: 'var(--sg-text)', fontWeight: 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ flexShrink: 0, marginLeft: 12 }}>{children}</div>
  </div>
);

const ChipGroup = <T extends string>({
  options, value, onChange, colors,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  colors?: Record<T, string>;
}) => (
  <div style={{ display: 'flex', gap: 6 }}>
    {options.map(o => {
      const active = value === o;
      const accent = colors ? colors[o] : '#22c55e';
      return (
        <button key={o} onClick={() => onChange(o)} style={{
          background: active ? `${accent}20` : 'var(--sg-elevated)',
          border: `1px solid ${active ? accent + '60' : 'var(--sg-border)'}`,
          borderRadius: 20, padding: '4px 11px', fontSize: 12, cursor: 'pointer',
          color: active ? accent : 'var(--sg-muted)', fontWeight: active ? 600 : 400, textTransform: 'capitalize',
        }}>{o}</button>
      );
    })}
  </div>
);

const AppSettings: React.FC = () => {
  /* Appearance & Display — backed by AppSettingsContext so changes apply
     instantly app-wide and persist across sessions (light is the default). */
  const {
    theme, setTheme, accent, setAccent, fontSize, setFontSize, density, setDensity,
    units, setUnits, numFmt, setNumFmt, timezone, setTimezone, dateFmt, setDateFmt,
    showKpi, setShowKpi, showActions, setShowActions, showEnergy, setShowEnergy,
    showFertilizer, setShowFertilizer,
    resetDefaults, formatTemp,
  } = useAppSettings();
  const conn = useConnection();
  const { logout } = useAuth();
  const gh = useGreenhouse();
  const history = useHistory();
  const [cacheCleared, setCacheCleared] = useState(false);
  const switchMode = (m: 'live' | 'demo') => {
    if (m === conn.mode) return;
    logout();
    conn.setMode(m);
    history.replace('/login');
  };
  const preview = formatTemp(26.4);

  /* Unsaved indicator */
  const [saved, setSaved] = useState(false);

  const saveAll = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/profile" />
      <IonContent className="ion-padding">

        <div className="sg-row-between" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)' }}>App Settings</div>
          {saved && <span className="sg-pill sg-pill-ok" style={{ fontSize: 11 }}>✓ Saved</span>}
        </div>

        {/* ── CONNECTION ── */}
        <div className="sg-card">
          <SectionTitle>Connection</SectionTitle>
          <SettingRow label="Data source" sub="Switching signs you out">
            <ChipGroup<'live' | 'demo'> options={['live', 'demo']} value={conn.mode} onChange={switchMode}
              colors={{ live: '#22c55e', demo: '#f59e0b' }} />
          </SettingRow>
          <div style={{ paddingTop: 10 }}><ConnectionEditor /></div>
        </div>

        {/* ── APPEARANCE ── */}
        <div className="sg-card">
          <SectionTitle>Appearance</SectionTitle>

          <SettingRow label="Theme" sub="Controls the overall colour scheme">
            <ChipGroup<Theme>
              options={['dark', 'light', 'system']}
              value={theme}
              onChange={setTheme}
            />
          </SettingRow>

          <SettingRow label="Accent Colour" sub="Primary action & status highlight">
            <div style={{ display: 'flex', gap: 8 }}>
              {(Object.keys(accentColors) as Accent[]).map(a => (
                <button key={a} onClick={() => setAccent(a)} style={{
                  width: 26, height: 26, borderRadius: '50%', border: 'none',
                  background: accentColors[a], cursor: 'pointer',
                  boxShadow: accent === a ? `0 0 0 3px var(--sg-bg), 0 0 0 5px ${accentColors[a]}` : 'none',
                  transition: 'box-shadow 0.15s',
                }} />
              ))}
            </div>
          </SettingRow>

          <SettingRow label="Font Size" sub="Applies to metric values and body text">
            <ChipGroup<FontSize> options={['small', 'medium', 'large']} value={fontSize} onChange={setFontSize} />
          </SettingRow>

          <SettingRow label="Card Density" sub="How much information fits on screen">
            <ChipGroup<Density> options={['compact', 'normal', 'comfortable']} value={density} onChange={setDensity} />
          </SettingRow>

          {/* Live preview */}
          <div style={{ marginTop: 14, marginBottom: 2 }}>
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginBottom: 8 }}>PREVIEW</div>
            <div style={{
              background: 'var(--sg-elevated)', border: `1px solid ${accentColors[accent]}30`,
              borderRadius: 10, padding: density === 'compact' ? 8 : density === 'comfortable' ? 16 : 12,
            }}>
              <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginBottom: 4 }}>Temperature</div>
              <div style={{
                fontSize: fontSize === 'small' ? 24 : fontSize === 'large' ? 40 : 32,
                fontWeight: 700, color: accentColors[accent], lineHeight: 1,
              }}>
                {preview.value} <span style={{ fontSize: '40%', fontWeight: 400, color: 'var(--sg-muted)' }}>{preview.unit}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 4 }}>● OK · Last 14:15</div>
            </div>
          </div>
        </div>

        {/* ── DISPLAY ── */}
        <div className="sg-card">
          <SectionTitle>Display &amp; Units</SectionTitle>

          <SettingRow label="Unit System">
            <ChipGroup<Units> options={['metric', 'imperial']} value={units} onChange={setUnits} />
          </SettingRow>

          <SettingRow label="Number Format" sub="How large numbers are formatted">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['1,234.5', '1.234,5'] as const).map(f => (
                <button key={f} onClick={() => setNumFmt(f)} style={{
                  background: numFmt === f ? 'rgba(34,197,94,0.15)' : 'var(--sg-elevated)',
                  border: `1px solid ${numFmt === f ? 'rgba(34,197,94,0.4)' : 'var(--sg-border)'}`,
                  borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  color: numFmt === f ? '#22c55e' : 'var(--sg-muted)', fontFamily: 'monospace',
                }}>{f}</button>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="Timestamp Timezone">
            <ChipGroup<'utc' | 'local'> options={['utc', 'local']} value={timezone} onChange={setTimezone} />
          </SettingRow>

          <SettingRow label="Date Format">
            <div style={{ display: 'flex', gap: 6 }}>
              {[{ v: 'iso' as const, label: '2026-05-29' }, { v: 'regional' as const, label: '29/05/2026' }].map(f => (
                <button key={f.v} onClick={() => setDateFmt(f.v)} style={{
                  background: dateFmt === f.v ? 'rgba(34,197,94,0.15)' : 'var(--sg-elevated)',
                  border: `1px solid ${dateFmt === f.v ? 'rgba(34,197,94,0.4)' : 'var(--sg-border)'}`,
                  borderRadius: 8, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                  color: dateFmt === f.v ? '#22c55e' : 'var(--sg-muted)', fontFamily: 'monospace',
                }}>{f.label}</button>
              ))}
            </div>
          </SettingRow>
        </div>

        {/* ── DASHBOARD ── */}
        <div className="sg-card">
          <SectionTitle>Dashboard Customisation</SectionTitle>
          {[
            { label: 'Show KPI Row',              sub: 'Water, fertilizer, solar today', val: showKpi,       set: setShowKpi       },
            { label: 'Show Recent Actions',       sub: 'Last automated events list',     val: showActions,    set: setShowActions    },
            { label: 'Show Energy Mini-Status',   sub: 'Solar/battery in header',        val: showEnergy,     set: setShowEnergy     },
            { label: 'Show Fertilizer Card',      sub: 'Hopper weight widget',           val: showFertilizer, set: setShowFertilizer },
          ].map(r => (
            <SettingRow key={r.label} label={r.label} sub={r.sub}>
              <IonToggle checked={r.val} onIonChange={e => r.set(e.detail.checked)}
                style={{ '--track-background-checked': 'rgba(34,197,94,0.3)', '--handle-background-checked': '#22c55e' }} />
            </SettingRow>
          ))}
        </div>

        {/* ── NOTIFICATIONS ── */}
        <div className="sg-card">
          <SectionTitle>Notifications</SectionTitle>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', lineHeight: 1.5 }}>
            {gh.meta.capabilities.push
              ? 'Push notifications are enabled for this greenhouse.'
              : 'During the study period alerts appear in the app (the badge on More and the Alerts page) and on the greenhouse screen. Phone push notifications are planned for a later version.'}
          </div>
        </div>

        {/* ── DATA ── */}
        <div className="sg-card">
          <SectionTitle>Data on this device</SectionTitle>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            The app keeps the last snapshot so it can show last-known values while offline. Everything else stays on the controller.
          </div>
          <IonButton fill="outline" size="small" style={{ '--border-color': 'var(--sg-border)', '--color': '#ef4444', '--border-radius': '8px' }}
            onClick={() => { try { localStorage.removeItem('sg-live-cache'); } catch { /* ignore */ } setCacheCleared(true); }}>
            {cacheCleared ? 'Cleared' : 'Clear cached snapshot'}
          </IonButton>
        </div>

        {/* ── ABOUT ── */}
        <div className="sg-card">
          <SectionTitle>About</SectionTitle>
          {[
            { label: 'App version',     value: 'v1.0.0' },
            { label: 'Greenhouse',      value: `${gh.meta.name} (${gh.meta.id})` },
            { label: 'Team',            value: '404 Brains Not Found · SLSU capstone 2026' },
            { label: 'License',         value: 'Capstone project — not for distribution' },
          ].map((r, i) => (
            <div key={r.label} className="sg-row-between" style={{ padding: '7px 0', borderBottom: i < 3 ? '1px solid var(--sg-border)' : 'none' }}>
              <span style={{ fontSize: 13, color: 'var(--sg-muted)' }}>{r.label}</span>
              <span style={{ fontSize: 13, color: 'var(--sg-text)', fontWeight: 500 }}>{r.value}</span>
            </div>
          ))}
        </div>

        {/* Save button */}
        <IonButton expand="block"
          style={{ '--background': '#22c55e', '--color': '#000', '--border-radius': '12px', fontWeight: 700, marginBottom: 8 }}
          onClick={saveAll}>
          Save Settings
        </IonButton>

        <IonButton expand="block" fill="outline"
          style={{ '--border-color': 'var(--sg-border)', '--color': 'var(--sg-muted)', '--border-radius': '12px', marginBottom: 16 }}
          onClick={resetDefaults}>
          Reset to Defaults
        </IonButton>

      </IonContent>
    </IonPage>
  );
};

export default AppSettings;
