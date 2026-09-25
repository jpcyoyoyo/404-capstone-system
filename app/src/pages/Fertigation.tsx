import React, { useCallback, useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon, IonSpinner, useIonAlert } from '@ionic/react';
import { flaskOutline, waterOutline, scaleOutline, checkmarkCircle, closeCircle } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useCommand } from '../components/useCommand';
import { formatMetric } from '../providers/metrics';
import { statusColor } from '../components/display';
import { fmtDateTime } from '../components/format';
import type { FertilizerReport } from '../contract/types';

const PRESETS = [10, 20, 30, 50];
const HOPPER_CAPACITY_G = 1000;

const Fertigation: React.FC = () => {
  const gh = useGreenhouse();
  const { send, busy, blocked } = useCommand();
  const [alert] = useIonAlert();
  const [target, setTarget] = useState('20');
  const [report, setReport] = useState<FertilizerReport | null>(null);
  const [loading, setLoading] = useState(false);

  const auger = gh.actuators.auger;
  const augerDef = gh.meta.actuators.find(a => a.id === 'auger');
  const hopper = gh.metrics.hopper_weight;
  const level = gh.metrics.water_level;
  const ph = gh.metrics.ph;
  const dosing = !!auger?.on;

  const load = useCallback(() => {
    setLoading(true);
    gh.data.fertilizer(30).then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [gh.data]);
  useEffect(() => { load(); }, [load]);
  // Reload the history when a dose finishes.
  const [wasDosing, setWasDosing] = useState(dosing);
  useEffect(() => { if (wasDosing && !dosing) setTimeout(load, 800); setWasDosing(dosing); }, [dosing, wasDosing, load]);

  const g = Number(target);
  const valid = Number.isFinite(g) && g > 0 && g <= 500;

  const dose = () => {
    alert({
      header: `Dose ${g} g?`,
      message: 'The auger turns until the load cell reads the target, then stops. Make sure the reservoir is ready to receive fertilizer.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Dose', handler: () => { send({ actuator_id: 'auger', action: 'DOSE', target_g: g }); } }],
    });
  };

  const input: React.CSSProperties = {
    width: 90, background: 'var(--sg-elevated)', border: '1px solid var(--sg-border)', borderRadius: 8,
    padding: '8px 10px', fontSize: 16, fontWeight: 700, color: 'var(--sg-text)', fontFamily: 'inherit', outline: 'none',
  };

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/dashboard" />
      <IonContent className="ion-padding">
        <StatusBanner />

        <div className="sg-card">
          <div className="sg-row-between" style={{ marginBottom: 6 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={scaleOutline} style={{ color: '#a855f7' }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>Fertilizer hopper</span>
            </div>
            <span className={`sg-pill ${dosing ? 'sg-pill-info' : 'sg-pill-idle'}`}>{dosing ? 'DOSING' : 'IDLE'}</span>
          </div>
          <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--sg-text)' }}>
            {formatMetric('hopper_weight', hopper.value)}<span style={{ fontSize: 16, fontWeight: 400, color: 'var(--sg-muted)' }}> g</span>
          </div>
          <div className="sg-bar-track" style={{ marginTop: 6 }}>
            <div className="sg-bar-fill" style={{ width: `${Math.min(100, ((hopper.value ?? 0) / HOPPER_CAPACITY_G) * 100)}%`, background: statusColor(hopper.status) }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 6 }}>
            {hopper.note ?? (dosing ? auger?.reason : `Load cell (HX711) · about ${Math.round(((hopper.value ?? 0) / HOPPER_CAPACITY_G) * 100)}% of 1 kg`)}
          </div>
        </div>

        <div className="sg-row sg-gap-8" style={{ marginBottom: 12 }}>
          <div className="sg-kpi" style={{ flex: 1 }}>
            <div className="sg-row sg-gap-4" style={{ fontSize: 10, color: 'var(--sg-muted)' }}><IonIcon icon={waterOutline} /> Reservoir</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: statusColor(level.status) }}>{formatMetric('water_level', level.value)}{level.value !== null ? '%' : ''}</div>
          </div>
          <div className="sg-kpi" style={{ flex: 1 }}>
            <div className="sg-row sg-gap-4" style={{ fontSize: 10, color: 'var(--sg-muted)' }}><IonIcon icon={flaskOutline} /> Nutrient pH</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: statusColor(ph.status) }}>{formatMetric('ph', ph.value)}</div>
          </div>
          <div className="sg-kpi" style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>EC</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--sg-dim)' }}>{gh.metrics.ec.installed ? formatMetric('ec', gh.metrics.ec.value) : 'n/a'}</div>
          </div>
        </div>

        <div className="sg-card">
          <div className="sg-section-title">Manual dose</div>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginBottom: 10 }}>
            Automatic fertigation is off for the study period; doses are started here and weighed by the load cell.
          </div>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <span key={p} className={`sg-filter-pill ${Number(target) === p ? 'active' : ''}`} onClick={() => setTarget(String(p))}>{p} g</span>
            ))}
          </div>
          <div className="sg-row sg-gap-8">
            <input type="number" inputMode="decimal" min={1} max={500} value={target} onChange={e => setTarget(e.target.value)} style={input} />
            <span style={{ color: 'var(--sg-muted)' }}>g</span>
            <div style={{ flex: 1 }} />
            {busy === 'auger' ? <IonSpinner name="dots" /> : (
              <IonButton disabled={!valid || dosing || !!blocked || !augerDef?.installed || busy !== null} onClick={dose}>
                {dosing ? 'Dosing…' : 'Dose'}
              </IonButton>
            )}
          </div>
          {dosing && (
            <IonButton size="small" fill="outline" color="danger" style={{ marginTop: 10 }} disabled={!!blocked}
              onClick={() => send({ actuator_id: 'auger', action: 'OFF', duration_s: 60 })}>Stop dose</IonButton>
          )}
          {blocked && <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 8 }}>{blocked}</div>}
        </div>

        <div className="sg-card">
          <div className="sg-row-between" style={{ marginBottom: 8 }}>
            <div className="sg-section-title" style={{ marginBottom: 0 }}>Doses · last 30 days</div>
            {loading && <IonSpinner name="dots" />}
          </div>
          {report && (
            <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
              {[
                { l: 'Doses', v: `${report.complete}/${report.count}` },
                { l: 'Delivered', v: `${report.total_delivered_g} g` },
                { l: 'Mean error', v: report.mean_abs_error_g !== null ? `±${report.mean_abs_error_g} g` : '—' },
              ].map(k => (
                <div key={k.l} className="sg-kpi" style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>{k.l}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{k.v}</div>
                </div>
              ))}
            </div>
          )}
          {report?.doses.length ? report.doses.slice(0, 15).map(d => (
            <div key={d.id} className="sg-row-between" style={{ padding: '8px 0', borderTop: '1px solid var(--sg-border)' }}>
              <div className="sg-row sg-gap-8">
                <IonIcon icon={d.status === 'complete' ? checkmarkCircle : closeCircle} style={{ color: d.status === 'complete' ? '#22c55e' : '#ef4444' }} />
                <div>
                  <div style={{ fontSize: 13, color: 'var(--sg-text)' }}>{d.target_g} g target → {d.delivered_g ?? '—'} g</div>
                  <div style={{ fontSize: 10, color: 'var(--sg-dim)' }}>{fmtDateTime(d.started_at)} · {d.issued_by}{d.reason ? ` · ${d.reason}` : ''}</div>
                </div>
              </div>
              <span style={{ fontSize: 12, color: d.error_g !== null && Math.abs(d.error_g) > 2 ? '#f59e0b' : 'var(--sg-muted)' }}>
                {d.error_g !== null ? `${d.error_g > 0 ? '+' : ''}${d.error_g} g` : ''}
              </span>
            </div>
          )) : !loading && <div style={{ fontSize: 12, color: 'var(--sg-dim)' }}>No doses recorded yet.</div>}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default Fertigation;
