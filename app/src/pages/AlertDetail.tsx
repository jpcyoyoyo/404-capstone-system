import React, { useEffect, useState } from 'react';
import { IonPage, IonContent, IonButton, IonIcon, IonSpinner, useIonToast } from '@ionic/react';
import { useParams, useHistory } from 'react-router-dom';
import { checkmarkCircle, bulbOutline } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { useAuth } from '../contexts/AuthContext';
import type { AlertItem } from '../contract/types';
import { alertTitle, SUGGESTED_ACTIONS } from '../contract/codes';
import { fmtDateTime } from '../components/format';
import { formatMetric, METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import { SEV_COLOR, SEV_ICON } from './Alerts';

const AlertDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const gh = useGreenhouse();
  const { isAdmin } = useAuth();
  const [toast] = useIonToast();
  const [alert, setAlert] = useState<AlertItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    gh.data.alerts('all', 500)
      .then(list => { if (alive) setAlert(list.find(a => String(a.id) === id) ?? null); })
      .catch(() => { if (alive) setAlert(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [gh.data, id]);

  const ack = async () => {
    if (!alert) return;
    setAcking(true);
    try {
      setAlert(await gh.data.ackAlert(alert.id));
      gh.reloadAlerts();
      toast({ message: 'Marked as seen.', duration: 2000, color: 'success', position: 'top' });
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Could not acknowledge.', duration: 3500, color: 'danger', position: 'top' });
    } finally { setAcking(false); }
  };

  if (loading) {
    return <IonPage><PersistentHeader showBack defaultHref="/tabs/alerts" /><IonContent className="ion-padding"><IonSpinner name="dots" /></IonContent></IonPage>;
  }
  if (!alert) {
    return (
      <IonPage>
        <PersistentHeader showBack defaultHref="/tabs/alerts" />
        <IonContent className="ion-padding">
          <div className="sg-card" style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>Alert not found</div>
            <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 4 }}>It may have been cleared, or you are viewing a different greenhouse.</div>
            <IonButton size="small" style={{ marginTop: 12 }} onClick={() => history.replace('/tabs/alerts')}>Back to alerts</IonButton>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  const c = SEV_COLOR[alert.severity];
  const sensor = gh.meta.sensors.find(s => s.id === alert.source);
  const reading = sensor ? gh.readings[sensor.id] : undefined;
  const metricKey = (sensor?.type ?? alert.source) as MetricKey;
  const metric = METRIC_INFO[metricKey] ? gh.metrics[metricKey] : undefined;
  const actions = SUGGESTED_ACTIONS[alert.code] ?? [];

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/alerts" />
      <IonContent className="ion-padding">
        <div className="sg-card" style={{ borderLeft: `3px solid ${c}` }}>
          <div className="sg-row sg-gap-8" style={{ marginBottom: 6 }}>
            <IonIcon icon={SEV_ICON[alert.severity]} style={{ color: c, fontSize: 22 }} />
            <span className="sg-pill" style={{ background: `${c}1f`, color: c, borderColor: `${c}55` }}>{alert.severity.toUpperCase()}</span>
            {alert.resolved_at ? <span className="sg-pill sg-pill-ok">RESOLVED</span> : <span className="sg-pill sg-pill-crit">OPEN</span>}
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--sg-text)' }}>{alertTitle(alert.code)}</div>
          <div style={{ fontSize: 13, color: 'var(--sg-muted)', marginTop: 4, lineHeight: 1.5 }}>{alert.message}</div>
        </div>

        <div className="sg-card">
          {[
            ['Code', alert.code],
            ['Source', alert.source],
            ['Raised', fmtDateTime(alert.raised_at)],
            ['Last seen', fmtDateTime(alert.last_seen_at ?? alert.raised_at)],
            ['Resolved', alert.resolved_at ? fmtDateTime(alert.resolved_at) : 'still open'],
            ['Seen by', alert.acknowledged_by ? `${alert.acknowledged_by} · ${fmtDateTime(alert.acknowledged_at)}` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="sg-row-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--sg-border)' }}>
              <span style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{k}</span>
              <span style={{ fontSize: 12, color: 'var(--sg-text)', fontFamily: k === 'Code' ? 'monospace' : undefined }}>{v}</span>
            </div>
          ))}
        </div>

        {(reading || metric) && (
          <div className="sg-card">
            <div className="sg-section-title">Now</div>
            {reading && <div style={{ fontSize: 13, color: 'var(--sg-text)' }}>{sensor?.id}: {reading.value ?? '—'} {reading.unit} · {reading.quality}</div>}
            {metric && (
              <div style={{ fontSize: 13, color: 'var(--sg-text)', marginTop: 4, cursor: 'pointer' }} onClick={() => history.push(`/tabs/live-monitor/metric/${metricKey}`)}>
                {metric.label}: {formatMetric(metricKey, metric.value)} {metric.unit}{metric.band ? ` (target ${metric.band.min}–${metric.band.max})` : ''} →
              </div>
            )}
          </div>
        )}

        {actions.length > 0 && (
          <div className="sg-card">
            <div className="sg-row sg-gap-8" style={{ marginBottom: 6 }}>
              <IonIcon icon={bulbOutline} style={{ color: '#f59e0b' }} />
              <span className="sg-section-title" style={{ marginBottom: 0 }}>What to do</span>
            </div>
            {actions.map(a => <div key={a} style={{ fontSize: 13, color: 'var(--sg-text)', padding: '4px 0' }}>• {a}</div>)}
          </div>
        )}

        {!alert.acknowledged_at ? (
          <IonButton expand="block" disabled={acking || !isAdmin} onClick={ack}
            style={{ '--background': '#22c55e', '--color': '#000', '--border-radius': '12px', fontWeight: 700 }}>
            <IonIcon icon={checkmarkCircle} slot="start" /> {acking ? 'Saving…' : 'Mark as seen'}
          </IonButton>
        ) : (
          <div style={{ textAlign: 'center', fontSize: 12, color: '#22c55e' }}>Seen by {alert.acknowledged_by}</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--sg-dim)', textAlign: 'center', marginTop: 8 }}>
          Ongoing conditions close by themselves when the problem goes away; one-off events (emergency stop, stopped dose) close when marked as seen.
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AlertDetail;
