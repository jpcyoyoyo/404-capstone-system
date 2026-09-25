import React, { useState } from 'react';
import { IonPage, IonContent, IonIcon } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { pulseOutline } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import Sparkline from '../components/Sparkline';
import { useAppSettings } from '../contexts/AppSettingsContext';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { formatMetric, METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { Quality } from '../contract/types';
import { METRIC_ICON, statusColor } from '../components/display';
import { timeAgo } from '../components/format';

const AIR: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light'];
const RESERVOIR: MetricKey[] = ['co2', 'ph', 'ec', 'water_level', 'water_temperature', 'hopper_weight', 'water_flow'];

const Q_PILL: Record<Quality, string> = {
  VALID: 'sg-pill-ok', WARMING: 'sg-pill-info', STALE: 'sg-pill-warn', INVALID: 'sg-pill-crit', UNCALIBRATED: 'sg-pill-warn',
};

const LiveMonitor: React.FC = () => {
  const history = useHistory();
  const gh = useGreenhouse();
  const { formatTemp } = useAppSettings();
  const [zone, setZone] = useState<'all' | number>('all');

  const tiles = (keys: MetricKey[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
      {keys.map(k => {
        const m = gh.metrics[k];
        if (!m.installed) return null;
        const c = statusColor(m.status);
        const t = k === 'temperature' && m.value !== null ? formatTemp(m.value) : null;
        const h = m.history;
        return (
          <div key={k} className="sg-snap-tile" style={{ cursor: 'pointer' }} onClick={() => history.push(`/tabs/live-monitor/metric/${k}`)}>
            <div className="sg-row sg-gap-8" style={{ marginBottom: 8 }}>
              <div className="sg-icon-chip" style={{ width: 28, height: 28, background: `${c}1f`, color: c }}>
                <IonIcon icon={METRIC_ICON[k]} style={{ fontSize: 14 }} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--sg-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{METRIC_INFO[k].short}</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--sg-text)', lineHeight: 1, marginBottom: 6 }}>
              {t ? t.value : formatMetric(k, m.value)}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--sg-muted)', marginLeft: 3 }}>{m.value !== null ? (t ? t.unit : m.unit) : ''}</span>
            </div>
            <Sparkline data={h} color={c} width={100} height={20} />
            <div className="sg-row-between" style={{ marginTop: 6, fontSize: 10, color: 'var(--sg-dim)' }}>
              {m.note ? <span style={{ color: c }}>{m.note}</span> : h.length > 1 ? <>
                <span>↘ {formatMetric(k, Math.min(...h))}</span><span>↗ {formatMetric(k, Math.max(...h))}</span>
              </> : <span>{m.band ? `target ${m.band.min}–${m.band.max}` : ''}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );

  const zoneSensors = zone === 'all' ? [] : gh.meta.sensors.filter(s => s.zone === zone);
  const zoneNode = zone === 'all' ? undefined : gh.meta.nodes.find(n => n.zone === zone);
  const problems = Object.values(gh.metrics).filter(m => m.installed && (m.status === 'crit' || m.status === 'warn' || m.manualRequired.length));
  const stageName = gh.meta.stages.find(s => s.id === gh.activeStageId)?.name ?? gh.activeStageId;

  return (
    <IonPage>
      <PersistentHeader />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div className="sg-row-between" style={{ marginBottom: 12 }}>
          <div className="sg-row sg-gap-8">
            <IonIcon icon={pulseOutline} style={{ color: gh.streaming ? '#ef4444' : 'var(--sg-muted)' }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: gh.streaming ? '#ef4444' : 'var(--sg-muted)' }}>
              {gh.mode === 'demo' ? 'SIMULATED' : gh.streaming ? 'LIVE' : 'POLLING'}
            </span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--sg-dim)' }}>Updated {timeAgo(gh.lastUpdate)}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 2 }}>
          <span className={`sg-filter-pill ${zone === 'all' ? 'active' : ''}`} onClick={() => setZone('all')}>Greenhouse</span>
          {gh.meta.zones.map(z => (
            <span key={z.id} className={`sg-filter-pill ${zone === z.id ? 'active' : ''}`} onClick={() => setZone(z.id)}>{z.name}</span>
          ))}
        </div>

        {zone === 'all' ? (
          <>
            <div className="sg-section-title">Growing area (median per zone, averaged)</div>
            {tiles(AIR)}
            <div className="sg-section-title">Reservoir & controller</div>
            {tiles(RESERVOIR)}
          </>
        ) : (
          <div className="sg-card" style={{ padding: 0 }}>
            <div className="sg-row-between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--sg-border)' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--sg-text)' }}>{gh.meta.zones.find(z => z.id === zone)?.description}</span>
              {zoneNode && (
                <span className={`sg-pill ${gh.nodes[zoneNode.id] ? 'sg-pill-ok' : 'sg-pill-crit'}`}>{zoneNode.id.replace('_', ' ')} {gh.nodes[zoneNode.id] ? 'online' : 'offline'}</span>
              )}
            </div>
            {zoneSensors.map((s, i) => {
              const r = gh.readings[s.id];
              const k = s.type as MetricKey;
              const known = k in METRIC_INFO;
              return (
                <div key={s.id} className="sg-row-between" style={{ padding: '10px 14px', borderBottom: i < zoneSensors.length - 1 ? '1px solid var(--sg-border)' : 'none', opacity: s.installed ? 1 : 0.5 }}>
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--sg-text)', fontWeight: 600 }}>{known ? METRIC_INFO[k].label : s.type.replace('_', ' ')}</div>
                    <div style={{ fontSize: 10, color: 'var(--sg-dim)', fontFamily: 'monospace' }}>{s.id}{r ? ` · ${timeAgo(r.ts)}` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>
                      {!s.installed ? '—' : s.type === 'float_switch' ? (r?.value === 1 ? 'Water OK' : r?.value === 0 ? 'LOW' : '—') : known ? formatMetric(k, r?.value) : (r?.value ?? '—')}
                      <span style={{ fontSize: 10, color: 'var(--sg-muted)', marginLeft: 2 }}>{s.installed && s.type !== 'float_switch' && r?.value !== null && r ? s.unit : ''}</span>
                    </div>
                    <span className={`sg-pill ${s.installed ? (r ? Q_PILL[r.quality] : 'sg-pill-idle') : 'sg-pill-idle'}`} style={{ fontSize: 9 }}>
                      {s.installed ? (r?.quality ?? 'NO DATA') : 'NOT INSTALLED'}
                    </span>
                  </div>
                </div>
              );
            })}
            {Object.entries(gh.zones).filter(([, z]) => z.zones[String(zone)]).length > 0 && (
              <div style={{ padding: '10px 14px', background: 'var(--sg-elevated)', fontSize: 11, color: 'var(--sg-muted)' }}>
                Zone medians: {Object.entries(gh.zones).filter(([, z]) => z.zones[String(zone)]?.median != null).map(([k, z]) =>
                  `${METRIC_INFO[k as MetricKey]?.short ?? k} ${formatMetric(k as MetricKey, z.zones[String(zone)].median)} (${z.zones[String(zone)].valid}/${z.zones[String(zone)].total} valid)`).join(' · ')}
              </div>
            )}
          </div>
        )}

        <div className="sg-card" style={{ marginTop: 14, border: `1px solid ${problems.length ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.3)'}`, background: problems.length ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: problems.length ? '#f59e0b' : '#22c55e' }}>
            {problems.length ? `${problems.length} parameter${problems.length > 1 ? 's' : ''} need attention` : 'Everything within the targets'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--sg-muted)', marginTop: 2, lineHeight: 1.5 }}>
            {problems.length
              ? problems.map(m => `${m.label}${m.note ? ` (${m.note})` : ''}`).join(', ')
              : `All readings are inside the ${stageName} stage targets.`}
          </div>
        </div>
        <div style={{ height: 8 }} />
      </IonContent>
    </IonPage>
  );
};

export default LiveMonitor;
