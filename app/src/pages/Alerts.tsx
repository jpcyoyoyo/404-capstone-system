import React, { useCallback, useEffect, useState } from 'react';
import { IonPage, IonContent, IonIcon, IonSpinner, IonRefresher, IonRefresherContent } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { alertCircle, warningOutline, informationCircleOutline, chevronForward, checkmarkCircle } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import type { AlertItem, AlertSeverity } from '../contract/types';
import { alertTitle } from '../contract/codes';
import { timeAgo } from '../components/format';

export const SEV_ICON: Record<AlertSeverity, string> = { critical: alertCircle, high: alertCircle, medium: warningOutline, low: informationCircleOutline };
export const SEV_COLOR: Record<AlertSeverity, string> = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#3b82f6' };

const FILTERS = ['Open', 'Unread', 'All'] as const;
type Filter = typeof FILTERS[number];

const Alerts: React.FC = () => {
  const history = useHistory();
  const gh = useGreenhouse();
  const [filter, setFilter] = useState<Filter>('Open');
  const [items, setItems] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setItems(await gh.data.alerts(filter === 'Open' ? 'open' : filter === 'Unread' ? 'unacknowledged' : 'all', 200));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load alerts.'); }
    finally { setLoading(false); }
  }, [gh.data, filter]);

  // Reload when the provider's open-alert list changes (new alert over MQTT, ack elsewhere).
  const signature = gh.openAlerts.map(a => `${a.id}:${a.acknowledged_at ?? ''}`).join(',') + `|${gh.unackedCount}`;
  useEffect(() => { load(); }, [load, signature]);

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/more" />
      <IonContent className="ion-padding">
        <IonRefresher slot="fixed" onIonRefresh={e => load().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <StatusBanner />
        <div className="sg-row-between" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)' }}>Alerts</div>
          {loading && <IonSpinner name="dots" />}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {FILTERS.map(f => (
            <span key={f} className={`sg-filter-pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f}{f === 'Unread' && gh.unackedCount ? ` (${gh.unackedCount})` : ''}
            </span>
          ))}
        </div>
        {err && <div className="sg-banner-offline" style={{ marginBottom: 12 }}>{err}</div>}
        {!loading && !err && items.length === 0 && (
          <div className="sg-card" style={{ textAlign: 'center', padding: 24 }}>
            <IonIcon icon={checkmarkCircle} style={{ fontSize: 30, color: '#22c55e' }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)', marginTop: 6 }}>Nothing here</div>
            <div style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{filter === 'Open' ? 'No open alerts right now.' : 'No alerts match this filter.'}</div>
          </div>
        )}
        {items.map(a => {
          const acked = !!a.acknowledged_at;
          return (
            <div key={a.id} className="sg-card" style={{ cursor: 'pointer', opacity: a.resolved_at ? 0.7 : 1, borderLeft: `3px solid ${SEV_COLOR[a.severity]}` }}
              onClick={() => history.push(`/tabs/alert-detail/${a.id}`)}>
              <div className="sg-row sg-gap-12" style={{ alignItems: 'flex-start' }}>
                <IonIcon icon={SEV_ICON[a.severity]} style={{ color: SEV_COLOR[a.severity], fontSize: 20, flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="sg-row-between">
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{alertTitle(a.code)}</span>
                    <span style={{ fontSize: 10, color: 'var(--sg-dim)', flexShrink: 0 }}>{timeAgo(a.raised_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 2 }}>{a.message}</div>
                  <div className="sg-row sg-gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                    <span className="sg-pill sg-pill-idle" style={{ fontSize: 9 }}>{a.severity.toUpperCase()}</span>
                    <span style={{ fontSize: 10, color: 'var(--sg-dim)' }}>{a.source}</span>
                    {a.resolved_at && <span className="sg-pill sg-pill-ok" style={{ fontSize: 9 }}>RESOLVED</span>}
                    {acked && <span className="sg-row sg-gap-4" style={{ fontSize: 10, color: '#22c55e' }}><IonIcon icon={checkmarkCircle} /> seen by {a.acknowledged_by}</span>}
                  </div>
                </div>
                <IonIcon icon={chevronForward} style={{ color: 'var(--sg-dim)', fontSize: 16, alignSelf: 'center' }} />
              </div>
            </div>
          );
        })}
      </IonContent>
    </IonPage>
  );
};

export default Alerts;
