import React, { useCallback, useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonSpinner, useIonToast } from '@ionic/react';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { CalibrationBody, CalibrationEntry } from '../contract/types';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import { fmtDateTime } from '../components/format';

const DUE_DAYS: Record<string, number> = { ph: 14, ec: 14, soil_moisture: 90, hopper_weight: 90 };
const KIND_TEXT: Record<string, string> = {
  dry_wet: 'Two readings: probe in dry air, then in water.',
  two_point: 'Two buffer solutions (pH 4.01 and 6.86), optional 9.18 to verify.',
  scale: 'Empty hopper, then a known weight.',
};

const input: React.CSSProperties = {
  width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
  padding: '8px 10px', color: 'var(--sg-text)', fontSize: 14, fontFamily: 'inherit', outline: 'none',
};

type Fields = Record<string, string>;

/** One capture row: a number field plus "Use live" to copy the sensor's current raw value. */
const Capture: React.FC<{ label: string; value: string; live: number | null | undefined; onChange: (v: string) => void }> = ({ label, value, live, onChange }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 3 }}>{label}</div>
    <div className="sg-row sg-gap-8">
      <input style={input} type="number" inputMode="decimal" step="any" value={value} onChange={e => onChange(e.target.value)} />
      <IonButton size="small" fill="outline" disabled={live === null || live === undefined} onClick={() => onChange(String(live))}>Use live</IonButton>
    </div>
  </div>
);

const Wizard: React.FC<{ entry: CalibrationEntry; onDone: () => void }> = ({ entry, onDone }) => {
  const gh = useGreenhouse();
  const [toast] = useIonToast();
  const [f, setF] = useState<Fields>({ ref1: '4.01', ref2: '6.86', ref3: '9.18', known: '500' });
  const [saving, setSaving] = useState(false);
  const live = gh.readings[entry.sensor_id]?.raw;
  const set = (k: string) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const num = (k: string) => (f[k] === undefined || f[k] === '' ? undefined : Number(f[k]));

  let body: CalibrationBody | null = null;
  if (entry.kind === 'dry_wet' && num('dry') !== undefined && num('wet') !== undefined) body = { kind: 'dry_wet', dry: num('dry'), wet: num('wet') };
  if (entry.kind === 'two_point' && num('raw1') !== undefined && num('raw2') !== undefined) {
    const points = [{ raw: num('raw1')!, ref: num('ref1')! }, { raw: num('raw2')!, ref: num('ref2')! }];
    if (num('raw3') !== undefined) points.push({ raw: num('raw3')!, ref: num('ref3')! });
    body = { kind: 'two_point', points };
  }
  if (entry.kind === 'scale' && num('offset') !== undefined && num('atKnown') !== undefined && num('known')) {
    body = { kind: 'scale', offset: num('offset'), raw_at_known: num('atKnown'), known_g: num('known') };
  }

  const save = async () => {
    if (!body) return;
    setSaving(true);
    try {
      const r = await gh.data.calibrate(entry.sensor_id, { ...body, note: f.note ?? '' });
      const verify = (r.constants as { verify?: { error: number } }).verify;
      toast({ message: `${gh.mode === 'demo' ? 'SIMULATED — ' : ''}Saved for ${entry.sensor_id}${verify ? ` · check error ${verify.error}` : ''}.`, duration: 3000, color: 'success', position: 'top' });
      onDone();
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Calibration failed.', duration: 4000, color: 'danger', position: 'top' });
    } finally { setSaving(false); }
  };

  return (
    <div style={{ marginTop: 10, padding: 10, background: 'var(--sg-elevated)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 8 }}>{KIND_TEXT[entry.kind]} Live raw now: <b style={{ color: 'var(--sg-text)' }}>{live ?? '—'}</b></div>
      {entry.kind === 'dry_wet' && <>
        <Capture label="1 · Probe in dry air (raw)" value={f.dry ?? ''} live={live} onChange={set('dry')} />
        <Capture label="2 · Probe in a glass of water (raw)" value={f.wet ?? ''} live={live} onChange={set('wet')} />
      </>}
      {entry.kind === 'two_point' && [1, 2, 3].map(i => (
        <div key={i} className="sg-row sg-gap-8" style={{ alignItems: 'flex-end' }}>
          <div style={{ width: 80 }}>
            <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 3 }}>Buffer {i === 3 ? '(check)' : i}</div>
            <input style={{ ...input, marginBottom: 8 }} type="number" step="any" value={f[`ref${i}`] ?? ''} onChange={e => set(`ref${i}`)(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}><Capture label="raw volts at the ADC" value={f[`raw${i}`] ?? ''} live={live} onChange={set(`raw${i}`)} /></div>
        </div>
      ))}
      {entry.kind === 'scale' && <>
        <Capture label="1 · Empty hopper (raw counts)" value={f.offset ?? ''} live={live} onChange={set('offset')} />
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginBottom: 3 }}>2 · Known weight placed (g)</div>
          <input style={input} type="number" step="any" value={f.known ?? ''} onChange={e => set('known')(e.target.value)} />
        </div>
        <Capture label="3 · Raw counts with the known weight" value={f.atKnown ?? ''} live={live} onChange={set('atKnown')} />
      </>}
      <input style={{ ...input, marginBottom: 8 }} placeholder="Note (optional)" value={f.note ?? ''} onChange={e => set('note')(e.target.value)} />
      <div className="sg-row sg-gap-8">
        <IonButton size="small" disabled={!body || saving} onClick={save}>{saving ? 'Saving…' : 'Save constants'}</IonButton>
        <IonButton size="small" fill="clear" color="medium" onClick={onDone}>Cancel</IonButton>
      </div>
    </div>
  );
};

const Calibration: React.FC = () => {
  const gh = useGreenhouse();
  const { isAdmin } = useAuth();
  const [list, setList] = useState<CalibrationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    gh.data.calibrations().then(setList).catch(e => setErr(e instanceof Error ? e.message : 'Could not load.')).finally(() => setLoading(false));
  }, [gh.data]);
  useEffect(() => { load(); }, [load]);

  const rows = list.filter(c => c.kind !== 'none');
  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/more" />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div className="sg-row-between" style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)' }}>Calibration</div>
          {loading && <IonSpinner name="dots" />}
        </div>
        <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          Nodes send raw values; the controller applies these constants, so recalibrating never needs a firmware update.
          pH is due every {DUE_DAYS.ph} days.
        </div>
        {err && <div className="sg-banner-offline" style={{ marginBottom: 12 }}>{err}</div>}
        {rows.map(c => {
          const due = DUE_DAYS[c.type] ?? 90;
          const state = !c.installed ? 'idle' : c.days_since === null ? 'crit' : c.days_since >= due ? 'warn' : 'ok';
          return (
            <div key={c.sensor_id} className="sg-card" style={{ opacity: c.installed ? 1 : 0.55 }}>
              <div className="sg-row-between">
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>{METRIC_INFO[c.type as MetricKey]?.label ?? c.type} · zone {c.zone}</div>
                  <div style={{ fontSize: 11, color: 'var(--sg-dim)', fontFamily: 'monospace' }}>{c.sensor_id} · {c.kind}</div>
                </div>
                <span className={`sg-pill sg-pill-${state}`}>
                  {!c.installed ? 'NOT INSTALLED' : c.days_since === null ? 'NEEDED' : `${c.days_since} d ago`}
                </span>
              </div>
              {c.calibrated_at && (
                <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 6 }}>
                  {fmtDateTime(c.calibrated_at)} by {c.performed_by} · {Object.entries(c.constants ?? {}).filter(([k]) => !['kind', 'note', 'simulated'].includes(k)).slice(0, 3).map(([k, v]) => `${k} ${typeof v === 'number' ? Number(v.toFixed(4)) : typeof v === 'object' ? '…' : v}`).join(', ')}
                </div>
              )}
              {c.installed && isAdmin && open !== c.sensor_id && (
                <IonButton size="small" fill="outline" style={{ marginTop: 8 }} disabled={gh.mode === 'live' && gh.link !== 'local'} onClick={() => setOpen(c.sensor_id)}>Calibrate</IonButton>
              )}
              {open === c.sensor_id && <Wizard entry={c} onDone={() => { setOpen(null); load(); }} />}
            </div>
          );
        })}
      </IonContent>
    </IonPage>
  );
};

export default Calibration;
