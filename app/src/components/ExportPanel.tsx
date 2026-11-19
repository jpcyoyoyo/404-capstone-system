// Records → Export: choose what, which period and how detailed; the controller (or cloud server) makes
// the file (GET /export, controller/greenhouse/export.py) and the app saves or shares it (saveFile.ts).
import React, { useEffect, useMemo, useState } from 'react';
import { IonButton, IonSpinner } from '@ionic/react';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { ExportDataset, ExportQuery } from '../api/client';
import { saveFile } from './saveFile';
import { PeriodId, periodRange, rawSizeMb, ymd } from './exportPeriod';

export type ExportPreset = { datasets: ExportDataset[]; types?: string[]; period?: PeriodId };
type Resolution = ExportQuery['resolution'];

const DATASETS: { id: ExportDataset; label: string; hint: string }[] = [
  { id: 'readings', label: 'Sensor readings', hint: 'every reading, or averages' },
  { id: 'summary', label: 'Sensor summary', hint: 'one row per sensor: readings, % valid, min, mean, max' },
  { id: 'water', label: 'Water use', hint: 'litres per day' },
  { id: 'fertilizer', label: 'Fertilizer doses', hint: 'target, delivered, error' },
  { id: 'activity', label: 'Activity log', hint: 'devices switched, settings changed' },
  { id: 'alerts', label: 'Alerts', hint: 'raised, resolved, acknowledged' },
  { id: 'power', label: 'Power events', hint: 'power cuts and restarts' },
];
const PERIODS: { id: PeriodId; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }, { id: 'custom', label: 'Dates…' },
];
const DETAIL: { id: Resolution; label: string }[] = [
  { id: 'raw', label: 'Every reading' }, { id: '15m', label: '15-min averages' },
  { id: '1h', label: 'Hourly' }, { id: '1d', label: 'Daily' },
];
const RAW_KEPT_DAYS = 7;   // controller/greenhouse/services/sensors.py (pH and EC: 30)
const STORE = 'sg-export-choices';

const load = (): Partial<{ resolution: Resolution; layout: 'long' | 'wide'; invalid: boolean }> => {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
};

const Pill: React.FC<{ on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, disabled, onClick, children }) => (
  <span className={`sg-filter-pill ${on ? 'active' : ''}`} onClick={disabled ? undefined : onClick}
    style={{ marginBottom: 6, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}>{children}</span>
);
const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sg-muted)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '10px 0 6px' }}>{children}</div>
);

const ExportPanel: React.FC<{
  preset: ExportPreset;
  /** The page's own quick CSV of what it shows (works in demo mode too). */
  onThisView: () => Promise<void>;
  onClose: () => void;
}> = ({ preset, onThisView, onClose }) => {
  const gh = useGreenhouse();
  const saved = useMemo(load, []);
  const [datasets, setDatasets] = useState<ExportDataset[]>(preset.datasets);
  const [types, setTypes] = useState<string[]>(preset.types ?? []);
  const [period, setPeriod] = useState<PeriodId>(preset.period ?? '24h');
  const today = ymd(new Date());
  const [custom, setCustom] = useState({ from: ymd(new Date(Date.now() - 6 * 86_400_000)), to: today });
  const [resolution, setResolution] = useState<Resolution>(saved.resolution ?? 'raw');
  const [layout, setLayout] = useState<'long' | 'wide'>(saved.layout ?? 'long');
  const [invalid, setInvalid] = useState(saved.invalid ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setDatasets(preset.datasets); setTypes(preset.types ?? []); if (preset.period) setPeriod(preset.period); setMsg(null); }, [preset]);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify({ resolution, layout, invalid })); } catch { /* private window */ } },
    [resolution, layout, invalid]);

  const installed = useMemo(() => {
    const t = new Set(gh.meta.sensors.filter(s => s.installed).map(s => s.type));
    return (Object.keys(METRIC_INFO) as MetricKey[]).filter(k => t.has(k));
  }, [gh.meta.sensors]);
  const [from, to] = periodRange(period, custom);
  const span = to.getTime() - from.getTime();
  const badDates = period === 'custom' && (!custom.from || !custom.to || span <= 0);
  const readings = datasets.includes('readings');
  const sensorCount = gh.meta.sensors.filter(s => s.installed && (!types.length || types.includes(s.type))).length;
  const wideOk = resolution !== 'raw';
  const many = datasets.length > 1;

  const toggle = (d: ExportDataset) => setDatasets(ds => ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d]);
  const toggleType = (t: string) => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t]);

  const run = async () => {
    setBusy(true); setMsg(null);
    try {
      const f = await gh.data.exportData({
        datasets: DATASETS.map(d => d.id).filter(d => datasets.includes(d)),
        from: from.toISOString(), to: to.toISOString(), types, resolution,
        layout: wideOk ? layout : 'long', invalid: resolution === 'raw' && invalid,
      });
      const r = await saveFile(f.filename, f.blob);
      const kb = f.blob.size < 1e6 ? `${Math.max(1, Math.round(f.blob.size / 1e3))} KB` : `${(f.blob.size / 1e6).toFixed(1)} MB`;
      setMsg(r === 'cancelled' ? { ok: false, text: 'Not saved: the share was cancelled.' }
        : { ok: true, text: `${r === 'shared' ? 'Ready to save or send' : 'Saved'}: ${f.filename} (${kb}).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'The export failed.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="sg-card" style={{ marginBottom: 12 }}>
      <div className="sg-row-between">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>Export data</div>
        <span onClick={onClose} style={{ fontSize: 12, color: 'var(--sg-muted)', cursor: 'pointer', padding: 4 }}>Close</span>
      </div>

      <Label>What</Label>
      <div className="sg-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {DATASETS.map(d => <Pill key={d.id} on={datasets.includes(d.id)} onClick={() => toggle(d.id)}>{d.label}</Pill>)}
      </div>
      {datasets.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--sg-dim)' }}>
          {DATASETS.filter(d => datasets.includes(d.id)).map(d => `${d.label}: ${d.hint}`).join(' · ')}
        </div>
      )}

      <Label>Period</Label>
      <div className="sg-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {PERIODS.map(p => <Pill key={p.id} on={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</Pill>)}
      </div>
      {period === 'custom' && (
        <div className="sg-row sg-gap-8" style={{ marginTop: 4, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--sg-muted)' }}>From{' '}
            <input type="date" value={custom.from} max={custom.to || today} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--sg-muted)' }}>To{' '}
            <input type="date" value={custom.to} min={custom.from} max={today} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
          </label>
        </div>
      )}

      {readings && (
        <>
          <Label>Sensors</Label>
          <div className="sg-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <Pill on={!types.length} onClick={() => setTypes([])}>All</Pill>
            {installed.map(k => <Pill key={k} on={types.includes(k)} onClick={() => toggleType(k)}>{METRIC_INFO[k].short}</Pill>)}
          </div>
          <Label>Detail</Label>
          <div className="sg-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {DETAIL.map(d => <Pill key={d.id} on={resolution === d.id} onClick={() => setResolution(d.id)}>{d.label}</Pill>)}
          </div>
          <Label>Layout</Label>
          <div className="sg-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <Pill on={layout === 'long' || !wideOk} onClick={() => setLayout('long')}>One row per reading</Pill>
            <Pill on={layout === 'wide' && wideOk} disabled={!wideOk} onClick={() => setLayout('wide')}>One column per sensor</Pill>
          </div>
          {resolution === 'raw' ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--sg-text)', marginTop: 4 }}>
              <input type="checkbox" checked={invalid} onChange={e => setInvalid(e.target.checked)} />
              Include readings that failed their checks (with the reason)
            </label>
          ) : null}
          <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 6 }}>
            {resolution === 'raw'
              ? `Every reading: about ${rawSizeMb(sensorCount, span)} MB for ${sensorCount} sensor${sensorCount === 1 ? '' : 's'}. `
                + (span > RAW_KEPT_DAYS * 86_400_000 ? `The controller keeps every reading for ${RAW_KEPT_DAYS} days (pH and EC 30); older days come out empty, so choose averages for longer periods. ` : '')
                + 'One column per sensor needs averages.'
              : `Averages of the valid readings; ${layout === 'wide' ? 'one column per sensor, ready for an Excel chart' : 'with min, max and the number of readings'}. Daily means midnight to midnight.`}
          </div>
        </>
      )}

      <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 10 }}>
        {datasets.length === 0 ? 'Choose at least one.'
          : many ? `One .zip with ${datasets.length} CSV files and a README that explains every column.`
            : 'One CSV file.'} Opens in Excel or Google Sheets; times are at the greenhouse and in UTC.
      </div>

      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok ? 'var(--sg-green)' : '#ef4444' }}>{msg.text}</div>}
      <div className="sg-row sg-gap-8" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <IonButton size="small" onClick={run} disabled={busy || datasets.length === 0 || badDates || gh.mode === 'demo'}>
          {busy ? <><IonSpinner name="dots" style={{ width: 18, height: 18 }} />&nbsp;Preparing…</> : 'Export'}
        </IonButton>
        <IonButton size="small" fill="outline" onClick={() => onThisView().catch(e => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }))} disabled={busy}>
          This view as CSV
        </IonButton>
      </div>
      {gh.mode === 'demo' && <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 6 }}>Demo mode: files come from the controller, so only “This view as CSV” works here.</div>}
    </div>
  );
};

export default ExportPanel;
