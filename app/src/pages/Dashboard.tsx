import React from 'react';
import { IonPage, IonContent, IonButton, IonIcon } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { waterOutline, flaskOutline, chevronForward, notificationsOutline, optionsOutline, analyticsOutline } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import { useAppSettings } from '../contexts/AppSettingsContext';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { formatMetric } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import { METRIC_ICON, ACTUATOR_ICON, statusColor, statusWord, bandPosition } from '../components/display';
import { fmtTime, untilText } from '../components/format';
import { alertTitle } from '../contract/codes';

const SNAPSHOT: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'ph', 'co2'];
const SYSTEMS = ['irrigation', 'lights', 'auger', 'fan_exhaust'];

const Dashboard: React.FC = () => {
  const history = useHistory();
  const gh = useGreenhouse();
  const { formatTemp } = useAppSettings();
  const stage = gh.meta.stages.find(s => s.id === gh.activeStageId);
  const critical = gh.openAlerts.filter(a => a.severity === 'critical' || a.severity === 'high');
  const irr = gh.actuators.irrigation;
  const level = gh.metrics.water_level;
  const hopper = gh.metrics.hopper_weight;
  const grey = gh.mode === 'live' && gh.link === 'offline' ? { opacity: 0.55 } : {};

  return (
    <IonPage>
      <PersistentHeader />
      <IonContent className="ion-padding">
        <StatusBanner />

        {critical.length > 0 && (
          <div className="sg-banner-solid-crit">
            <div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{critical.length === 1 ? alertTitle(critical[0].code).toUpperCase() : `${critical.length} URGENT ALERTS`}</div>
              <div style={{ fontSize: 11, opacity: 0.9 }}>{critical[0].message}</div>
            </div>
            <IonButton size="small" style={{ '--background': '#fff', '--color': '#ef4444', '--border-radius': '8px', fontWeight: 700 }}
              onClick={() => history.push(critical.length === 1 ? `/tabs/alert-detail/${critical[0].id}` : '/tabs/alerts')}>View</IonButton>
          </div>
        )}

        <div className="sg-row-between" style={{ marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Last update</div>
            <div style={{ fontSize: 13, color: 'var(--sg-text)', fontWeight: 500 }}>{fmtTime(gh.lastUpdate, true)}</div>
          </div>
          <div className="sg-row sg-gap-4" style={{ color: '#22c55e', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            onClick={() => history.push('/tabs/schedules')}>
            Thresholds <IonIcon icon={chevronForward} />
          </div>
        </div>

        <div className="sg-card" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <span className="sg-pill sg-pill-ok" style={{ marginBottom: 8, display: 'inline-block' }}>Active stage</span>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--sg-text)', letterSpacing: 0.5 }}>{(stage?.name ?? gh.activeStageId).toUpperCase()}</div>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 2 }}>
            {stage?.description} · irrigation by {stage?.irrigation_mode}
          </div>
        </div>

        <div className="sg-row-between" style={{ marginBottom: 8 }}>
          <div className="sg-section-title" style={{ marginBottom: 0 }}>Environment</div>
          <span style={{ fontSize: 12, color: '#3b82f6', cursor: 'pointer' }} onClick={() => history.push('/tabs/live-monitor')}>By zone</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14, ...grey }}>
          {SNAPSHOT.map(k => {
            const m = gh.metrics[k];
            const t = k === 'temperature' && m.value !== null ? formatTemp(m.value) : null;
            const value = t ? t.value : formatMetric(k, m.value);
            const unit = t ? t.unit : k === 'light' && m.value !== null && m.value >= 1000 ? 'lux' : k === 'ph' ? '' : m.unit;
            const c = statusColor(m.status);
            return (
              <div key={k} className="sg-snap-tile" onClick={() => history.push(`/tabs/live-monitor/metric/${k}`)} style={{ cursor: 'pointer' }}>
                <div className="sg-row sg-gap-8" style={{ marginBottom: 6 }}>
                  <div className="sg-icon-chip" style={{ width: 28, height: 28, background: `${c}1f`, color: c }}>
                    <IonIcon icon={METRIC_ICON[k]} style={{ fontSize: 14 }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{m.label}</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sg-text)', lineHeight: 1 }}>
                  {value}<span style={{ fontSize: 11, fontWeight: 400, marginLeft: 2, color: 'var(--sg-muted)' }}>{m.value !== null ? unit : ''}</span>
                </div>
                <div className="sg-bar-track" style={{ marginTop: 6 }}>
                  <div className="sg-bar-fill" style={{ width: `${bandPosition(m.value, m.band)}%`, background: c }} />
                </div>
                <div style={{ fontSize: 10, color: c, marginTop: 4, fontWeight: 600 }}>
                  {m.note ?? statusWord(m.status)}{m.band ? <span style={{ color: 'var(--sg-dim)', fontWeight: 400 }}> · {m.band.min}–{m.band.max}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sg-card">
          <div className="sg-section-title">Devices</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SYSTEMS.map(id => {
              const def = gh.meta.actuators.find(a => a.id === id);
              const st = gh.actuators[id];
              if (!def) return null;
              const on = !!st?.on;
              return (
                <div key={id} className="sg-act-pill" onClick={() => history.push('/tabs/controls')} style={{ opacity: def.installed ? 1 : 0.5 }}>
                  <IonIcon icon={ACTUATOR_ICON[id]} style={{ fontSize: 12 }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: on ? '#22c55e' : 'var(--sg-border)', flexShrink: 0 }} />
                  <span>{def.name}{!def.installed ? ' (not installed)' : st?.mode === 'MANUAL' ? ' · manual' : ''}</span>
                </div>
              );
            })}
          </div>
          {irr?.on && (
            <div style={{ fontSize: 11, color: 'var(--sg-muted)', marginTop: 8 }}>
              Irrigating by {irr.circuit} since {fmtTime(irr.since ?? irr.ts)}{irr.manual_until ? ` · ${untilText(irr.manual_until)}` : ''}
            </div>
          )}
        </div>

        <div className="sg-card" style={{ cursor: 'pointer', ...grey }} onClick={() => history.push('/tabs/fertigation')}>
          <div className="sg-row-between" style={{ marginBottom: 8 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={waterOutline} style={{ color: '#3b82f6' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>Reservoir</span>
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{formatMetric('water_level', level.value)}{level.value !== null ? '%' : ''}</span>
          </div>
          <div className="sg-bar-track">
            <div className="sg-bar-fill" style={{ width: `${level.value ?? 0}%`, background: statusColor(level.status) }} />
          </div>
          <div className="sg-row-between" style={{ marginTop: 10, marginBottom: 6 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={flaskOutline} style={{ color: '#a855f7' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--sg-text)' }}>Fertilizer hopper</span>
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--sg-text)' }}>{hopper.value !== null ? `${(hopper.value / 1000).toFixed(2)} kg` : '—'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--sg-dim)' }}>
            pH {formatMetric('ph', gh.metrics.ph.value)} · water {formatMetric('water_temperature', gh.metrics.water_temperature.value)}°C
            {gh.metrics.ec.installed ? ` · EC ${formatMetric('ec', gh.metrics.ec.value)}` : ''}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginTop: 4, marginBottom: 8 }}>
          {[
            { label: 'Controls', icon: optionsOutline,       color: '#3b82f6', path: '/tabs/controls' },
            { label: 'Dose',     icon: flaskOutline,         color: '#a855f7', path: '/tabs/fertigation' },
            { label: 'Records',  icon: analyticsOutline,     color: '#22c55e', path: '/tabs/records' },
            { label: 'Alerts',   icon: notificationsOutline, color: '#ef4444', path: '/tabs/alerts' },
          ].map(a => (
            <div key={a.label} onClick={() => history.push(a.path)} style={{ textAlign: 'center', cursor: 'pointer' }}>
              <div className="sg-icon-chip" style={{ margin: '0 auto 4px', background: `${a.color}1f`, color: a.color, width: 44, height: 44, borderRadius: 14 }}>
                <IonIcon icon={a.icon} style={{ fontSize: 18 }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--sg-muted)', fontWeight: 600 }}>{a.label}</div>
            </div>
          ))}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default Dashboard;
