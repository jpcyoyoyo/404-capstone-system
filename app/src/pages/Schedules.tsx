import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IonPage, IonContent, IonSegment, IonSegmentButton, IonLabel, IonButton, IonSpinner, useIonAlert, useIonToast } from '@ionic/react';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { AuditEntry, Threshold } from '../contract/types';
import { fmtDateTime } from '../components/format';

type Draft = Record<string, { min: string; max: string; deadband: string }>;

const toDraft = (list: Threshold[]): Draft =>
  Object.fromEntries(list.map(t => [t.parameter, { min: String(t.min), max: String(t.max), deadband: String(t.deadband) }]));

const PARAM_USE: Record<string, string> = {
  soil_moisture: 'Starts irrigation below min; stops at the middle of the band.',
  temperature: 'Exhaust fan above max (fan not installed yet — alerts only).',
  humidity: 'Fogging/exhaust decisions; alerts outside the band.',
  light: 'Grow lights on during the photoperiod when below min.',
  co2: 'Below min the exhaust fan stays off to keep CO₂ in.',
  ph: 'Alerts only; fertigation dosing is manual in the study period.',
  ec: 'EC probe not installed — kept for later.',
};

const Schedules: React.FC = () => {
  const gh = useGreenhouse();
  const { isAdmin } = useAuth();
  const [toast] = useIonToast();
  const [alert] = useIonAlert();
  const [view, setView] = useState(gh.activeStageId);
  const [list, setList] = useState<Threshold[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changes, setChanges] = useState<AuditEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const l = await gh.data.thresholds(view);
      setList(l); setDraft(toDraft(l));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load thresholds.'); }
    finally { setLoading(false); }
    gh.data.audit(300).then(a => setChanges(a.filter(x => x.action === 'threshold_updated' || x.action === 'stage_changed').slice(0, 10))).catch(() => setChanges([]));
  }, [gh.data, view]);

  useEffect(() => { load(); }, [load]);

  const edited = useMemo(() => list.filter(t => {
    const d = draft[t.parameter];
    return d && (Number(d.min) !== t.min || Number(d.max) !== t.max || Number(d.deadband) !== t.deadband);
  }), [list, draft]);

  const problems = useMemo(() => Object.entries(draft).flatMap(([p, d]) => {
    const [mn, mx, db] = [Number(d.min), Number(d.max), Number(d.deadband)];
    if ([mn, mx, db].some(v => Number.isNaN(v) || d.min === '' || d.max === '')) return [`${METRIC_INFO[p as MetricKey]?.short ?? p}: enter numbers`];
    if (mn >= mx) return [`${METRIC_INFO[p as MetricKey]?.short ?? p}: min must be below max`];
    if (db < 0) return [`${METRIC_INFO[p as MetricKey]?.short ?? p}: deadband cannot be negative`];
    return [];
  }), [draft]);

  const save = async () => {
    setSaving(true);
    try {
      const body = edited.map(t => ({ parameter: t.parameter, min: Number(draft[t.parameter].min), max: Number(draft[t.parameter].max), deadband: Number(draft[t.parameter].deadband) }));
      const res = await gh.data.putThresholds(view, body);
      setList(res); setDraft(toDraft(res));
      toast({ message: `${gh.mode === 'demo' ? 'SIMULATED — ' : ''}Saved ${body.length} threshold${body.length > 1 ? 's' : ''}. The controller uses them from its next cycle.`, duration: 3000, color: 'success', position: 'top' });
      load();
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Save failed.', duration: 4000, color: 'danger', position: 'top' });
    } finally { setSaving(false); }
  };

  const makeActive = () => {
    const st = gh.meta.stages.find(s => s.id === view);
    alert({
      header: `Switch to ${st?.name}?`,
      message: `Irrigation will use the ${st?.irrigation_mode} circuit and these thresholds from the next control cycle.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, {
        text: 'Switch', handler: () => {
          gh.setActiveStage(view)
            .then(() => toast({ message: `Active stage: ${st?.name}`, duration: 2500, color: 'success', position: 'top' }))
            .catch(e => toast({ message: e instanceof Error ? e.message : 'Could not switch.', duration: 4000, color: 'danger', position: 'top' }));
        },
      }],
    });
  };

  const c = gh.meta.control;
  const pump = gh.meta.actuators.find(a => a.id === 'pump');
  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 6,
    padding: '6px 8px', fontSize: 14, fontWeight: 600, color: 'var(--sg-text)', fontFamily: 'inherit', outline: 'none',
  };
  const canEdit = isAdmin && (gh.mode === 'demo' || gh.link === 'local');

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/more" />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)', marginBottom: 10 }}>Thresholds</div>

        <IonSegment value={view} onIonChange={e => setView(String(e.detail.value))} style={{ marginBottom: 10 }}>
          {gh.meta.stages.map(s => (
            <IonSegmentButton key={s.id} value={s.id}>
              <IonLabel style={{ fontSize: 13 }}>{s.name}{s.id === gh.activeStageId ? ' ●' : ''}</IonLabel>
            </IonSegmentButton>
          ))}
        </IonSegment>
        <div className="sg-row-between" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>
            {view === gh.activeStageId ? 'This is the active stage.' : 'Viewing a stage that is not active.'}
          </span>
          {view !== gh.activeStageId && isAdmin && <IonButton size="small" onClick={makeActive} disabled={!gh.canCommand && gh.mode === 'live'}>Make active</IonButton>}
        </div>

        {edited.length > 0 && (
          <div className="sg-banner-warn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span>{problems.length ? problems[0] : `${edited.length} unsaved change${edited.length > 1 ? 's' : ''}`}</span>
            <div className="sg-row sg-gap-8">
              <IonButton size="small" disabled={saving || problems.length > 0} onClick={save}>{saving ? 'Saving…' : 'Save'}</IonButton>
              <IonButton size="small" fill="clear" color="medium" onClick={() => setDraft(toDraft(list))}>Discard</IonButton>
            </div>
          </div>
        )}

        <div className="sg-card">
          <div className="sg-row-between">
            <div className="sg-section-title" style={{ marginBottom: 0 }}>Target bands</div>
            {loading && <IonSpinner name="dots" />}
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 8 }}>{err}</div>}
          {!canEdit && !loading && <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 6 }}>{isAdmin ? 'Thresholds are edited on the greenhouse network.' : 'Only an administrator can edit thresholds.'}</div>}
          {list.map((t, i) => {
            const d = draft[t.parameter] ?? { min: '', max: '', deadband: '' };
            const info = METRIC_INFO[t.parameter as MetricKey];
            const set = (k: keyof Draft[string]) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft(x => ({ ...x, [t.parameter]: { ...d, [k]: e.target.value } }));
            return (
              <div key={t.parameter} style={{ borderBottom: i < list.length - 1 ? '1px solid var(--sg-border)' : 'none', padding: '10px 0' }}>
                <div className="sg-row-between" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)' }}>
                    {info?.label ?? t.parameter} <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>({t.unit})</span>
                  </span>
                  {t.version ? <span style={{ fontSize: 10, color: 'var(--sg-dim)' }}>v{t.version}{t.updated_by && t.updated_by !== 'system' ? ` · ${t.updated_by}` : ''}</span> : null}
                </div>
                <div className="sg-row sg-gap-8">
                  {(['min', 'max', 'deadband'] as const).map(k => (
                    <div key={k} style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: 'var(--sg-muted)', marginBottom: 3 }}>{k === 'deadband' ? 'Deadband' : k === 'min' ? 'Min' : 'Max'}</div>
                      <input type="number" inputMode="decimal" step="any" value={d[k]} onChange={set(k)} disabled={!canEdit} style={inputStyle} />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 4 }}>{PARAM_USE[t.parameter]}</div>
              </div>
            );
          })}
        </div>

        <div className="sg-card">
          <div className="sg-section-title">Fixed control rules</div>
          {[
            ['Control cycle', `every ${c.cycle_s} s, using the median of valid sensors per zone`],
            ['Grow-light window', c.photoperiod ? `${c.photoperiod.start}–${c.photoperiod.end}` : '—'],
            ['Low-water lockout', 'pump and valves off below 15% reservoir level'],
            ['Float switch', 'independent low-water cut-out; disagreement with the level sensor locks the pump'],
            ['Pump limits', pump ? 'min 30 s on, 2 min off, max 15 min per run, 2 h per day' : '—'],
            ['Manual override', `up to ${Math.round(c.manual_override_max_s / 60)} min, then back to automatic`],
            ['Command expiry', `${c.command_expiry_s} s — late commands are refused`],
            ['Priority', 'safety › manual › temperature › humidity › CO₂ › fertigation › thresholds'],
            ['Fertigation', 'manual doses only in the study period'],
          ].map(([k, v]) => (
            <div key={k} className="sg-row-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--sg-border)', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--sg-muted)', flexShrink: 0 }}>{k}</span>
              <span style={{ fontSize: 12, color: 'var(--sg-text)', textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>

        {changes.length > 0 && (
          <div className="sg-card">
            <div className="sg-section-title">Recent changes</div>
            {changes.map(a => (
              <div key={a.id} className="sg-timeline-entry">
                <div style={{ fontSize: 12, color: 'var(--sg-text)' }}>
                  {a.action === 'stage_changed'
                    ? `Stage ${String((a.detail as Record<string, unknown>)?.old ?? '?')} → ${String((a.detail as Record<string, unknown>)?.new ?? '?')}`
                    : `${a.target.split(':').slice(1).join(' · ')} → ${String((a.detail as Record<string, unknown>)?.min ?? '')}–${String((a.detail as Record<string, unknown>)?.max ?? '')}`}
                </div>
                <div style={{ fontSize: 10, color: 'var(--sg-dim)' }}>{a.actor} · {fmtDateTime(a.occurred_at)}</div>
              </div>
            ))}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default Schedules;
