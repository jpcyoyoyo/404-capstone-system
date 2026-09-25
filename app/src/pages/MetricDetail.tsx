import React, { useEffect, useMemo, useState } from 'react';
import { IonPage, IonContent, IonIcon, IonSpinner } from '@ionic/react';
import { useParams, useHistory } from 'react-router-dom';
import { calendarOutline } from 'ionicons/icons';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import LineChart, { Series } from '../components/LineChart';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { formatMetric, METRIC_INFO, metricFromRoute } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { EventEntry, HistoryResult } from '../contract/types';
import { statusColor, statusWord } from '../components/display';
import { fmtDateTime } from '../components/format';

const CHOICES: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'water_level', 'water_temperature', 'hopper_weight'];
const RANGES = [
  { id: '6h', ms: 6 * 36e5, res: '15m' as const },
  { id: '24h', ms: 24 * 36e5, res: '15m' as const },
  { id: '7d', ms: 7 * 864e5, res: '1h' as const },
  { id: '30d', ms: 30 * 864e5, res: '1d' as const },
];
const ZONE_COLORS: Record<string, string> = { '0': '#14b8a6', '1': '#22c55e', '2': '#3b82f6' };
const RELATED_ACT: Partial<Record<MetricKey, string>> = { soil_moisture: 'irrigation', light: 'lights', humidity: 'irrigation', hopper_weight: 'auger', water_level: 'pump' };

const MetricDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const gh = useGreenhouse();
  const [metric, setMetric] = useState<MetricKey>(metricFromRoute(id) ?? 'temperature');
  const [range, setRange] = useState(RANGES[1]);
  const [data, setData] = useState<HistoryResult | null>(null);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { const k = metricFromRoute(id); if (k) setMetric(k); }, [id]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    const to = new Date();
    gh.data.history({ type: metric, from: new Date(to.getTime() - range.ms).toISOString(), to: to.toISOString(), resolution: range.res })
      .then(r => { if (alive) setData(r); })
      .catch(e => { if (alive) { setErr(e instanceof Error ? e.message : 'Could not load history'); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    const act = RELATED_ACT[metric];
    if (act) gh.data.events(20, act).then(e => { if (alive) setEvents(e); }).catch(() => setEvents([]));
    else setEvents([]);
    return () => { alive = false; };
  }, [gh.data, metric, range]);

  const m = gh.metrics[metric];
  const info = METRIC_INFO[metric];

  // One line per zone: average the sensors of that zone at each timestamp.
  const series: Series[] = useMemo(() => {
    if (!data) return [];
    const byZone = new Map<number, Map<number, number[]>>();
    for (const [sid, pts] of Object.entries(data.series)) {
      const s = gh.meta.sensors.find(x => x.id === sid);
      if (!s) continue;
      const zm = byZone.get(s.zone) ?? new Map<number, number[]>();
      for (const p of pts) {
        if (p.value === null) continue;
        const t = Date.parse(p.ts);
        zm.set(t, [...(zm.get(t) ?? []), p.value]);
      }
      byZone.set(s.zone, zm);
    }
    return [...byZone.entries()].sort((a, b) => a[0] - b[0]).map(([z, zm]) => ({
      name: gh.meta.zones.find(x => x.id === z)?.name ?? `Zone ${z}`,
      color: ZONE_COLORS[String(z)] ?? '#a855f7',
      points: [...zm.entries()].sort((a, b) => a[0] - b[0]).map(([t, vs]) => ({ t, v: vs.reduce((x, y) => x + y, 0) / vs.length })),
    }));
  }, [data, gh.meta]);

  const values = series.flatMap(s => s.points.map(p => p.v)).filter((v): v is number => v !== null);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const inBand = m.band && values.length ? Math.round((values.filter(v => v >= m.band!.min && v <= m.band!.max).length / values.length) * 100) : null;
  const c = statusColor(m.status);

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/live-monitor" />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 14 }}>
          {CHOICES.filter(k => gh.metrics[k].installed).map(k => (
            <span key={k} className={`sg-filter-pill ${metric === k ? 'active' : ''}`} onClick={() => { setMetric(k); history.replace(`/tabs/live-monitor/metric/${k}`); }}>
              {METRIC_INFO[k].short}
            </span>
          ))}
        </div>

        <div className="sg-card">
          <div className="sg-row-between">
            <div>
              <div style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{info.label} now</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--sg-text)' }}>
                {formatMetric(metric, m.value)}<span style={{ fontSize: 13, color: 'var(--sg-muted)', marginLeft: 4 }}>{m.value !== null ? m.unit : ''}</span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className="sg-pill" style={{ background: `${c}1f`, color: c, borderColor: `${c}55` }}>{m.note ?? statusWord(m.status)}</span>
              {m.band && <div style={{ fontSize: 11, color: 'var(--sg-dim)', marginTop: 6 }}>Target {m.band.min}–{m.band.max} {m.unit}</div>}
            </div>
          </div>
          {Object.keys(m.zones).length > 1 && (
            <div className="sg-row sg-gap-12" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {Object.entries(m.zones).map(([z, v]) => (
                <span key={z} style={{ fontSize: 11, color: 'var(--sg-muted)' }}>
                  {gh.meta.zones.find(x => String(x.id) === z)?.name}: <b style={{ color: 'var(--sg-text)' }}>{formatMetric(metric, v.median)}</b> ({v.valid}/{v.total} valid)
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="sg-card">
          <div className="sg-row-between" style={{ marginBottom: 10 }}>
            <div className="sg-row sg-gap-8">
              <IonIcon icon={calendarOutline} style={{ color: '#22c55e' }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>History</span>
            </div>
            {loading && <IonSpinner name="dots" />}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {RANGES.map(r => (
              <span key={r.id} className={`sg-filter-pill ${range.id === r.id ? 'active' : ''}`} onClick={() => setRange(r)}>{r.id}</span>
            ))}
          </div>
          {err ? <div style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{err}</div>
            : <LineChart series={series} band={m.band} unit={` ${m.unit}`} digits={info.digits} />}
          {gh.mode === 'demo' && <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 6 }}>Demo history is synthetic.</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Average', value: formatMetric(metric, avg) },
            { label: 'Low / high', value: values.length ? `${formatMetric(metric, Math.min(...values))} / ${formatMetric(metric, Math.max(...values))}` : '—' },
            { label: 'Time in target', value: inBand !== null ? `${inBand}%` : '—' },
          ].map(k => (
            <div key={k.label} className="sg-kpi">
              <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>{k.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)', marginTop: 2 }}>{k.value}</div>
            </div>
          ))}
        </div>

        {events.length > 0 && (
          <div className="sg-card">
            <div className="sg-section-title">Related device activity</div>
            {events.slice(0, 8).map(e => (
              <div key={e.id} className="sg-timeline-entry">
                <div className="sg-row-between">
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)' }}>{e.actuator_id} {e.action}</span>
                  <span style={{ fontSize: 11, color: 'var(--sg-dim)' }}>{fmtDateTime(e.occurred_at)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{e.reason} · {e.source}</div>
              </div>
            ))}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default MetricDetail;
