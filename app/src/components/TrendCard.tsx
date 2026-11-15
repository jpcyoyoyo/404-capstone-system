import React, { useCallback, useState } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { analyticsOutline, chevronForward } from 'ionicons/icons';
import LineChart, { ChartSeries } from './LineChart';
import { RANGES, RangeId } from './chartScale';
import { PerSensor, useHistoryChart } from './useHistoryChart';
import { zoneSeries } from './zoneSeries';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';

const CHOICES: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'water_level'];

/** Desktop overview: one history chart with a metric and range picker, so a remote viewer sees the
 *  trend without opening each metric. The full chart (stats, device activity) is a click away. */
const TrendCard: React.FC = () => {
  const gh = useGreenhouse();
  const history = useHistory();
  const [metric, setMetric] = useState<MetricKey>('temperature');
  const [rangeId, setRangeId] = useState<RangeId>('24h');
  const m = gh.metrics[metric];
  const info = METRIC_INFO[metric];
  const toSeries = useCallback((data: PerSensor): ChartSeries[] => zoneSeries(gh.meta, data), [gh.meta]);
  const hc = useHistoryChart(gh.data.history, { type: metric }, metric, rangeId, toSeries);

  return (
    <div className="sg-card">
      <div className="sg-row-between" style={{ marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div className="sg-row sg-gap-8">
          <IonIcon icon={analyticsOutline} style={{ color: 'var(--sg-green)' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--sg-text)' }}>Trend</span>
          {hc.loading && <IonSpinner name="dots" style={{ height: 16 }} />}
        </div>
        <div className="sg-row" style={{ gap: 4 }}>
          {RANGES.map(r => (
            <span key={r.id} className={`sg-filter-pill ${rangeId === r.id ? 'active' : ''}`} style={{ padding: '4px 10px' }}
              onClick={() => setRangeId(r.id)}>{r.id}</span>
          ))}
        </div>
      </div>
      <div className="sg-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {CHOICES.filter(k => gh.metrics[k].installed).map(k => (
          <span key={k} className={`sg-filter-pill ${metric === k ? 'active' : ''}`} onClick={() => setMetric(k)}>{METRIC_INFO[k].short}</span>
        ))}
      </div>
      {hc.err ? <div style={{ fontSize: 12, color: 'var(--sg-muted)' }}>{hc.err}</div>
        : <LineChart layers={hc.layers} full={hc.full} view={hc.view} onViewChange={hc.setView} minSpan={hc.range.minSpan}
            resetKey={hc.resetKey} updated={{ at: hc.updatedAt, everyMs: hc.range.refresh }} height={240}
            rangeLabel={`last ${hc.range.id}`} band={m.band} unit={` ${m.unit}`} digits={info.digits} />}
      <div className="sg-row-between" style={{ marginTop: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--sg-dim)' }}>{gh.mode === 'demo' ? 'Demo history is synthetic.' : ''}</span>
        <span className="sg-row sg-gap-4" style={{ fontSize: 12, color: 'var(--sg-green)', fontWeight: 600, cursor: 'pointer' }}
          onClick={() => history.push(`/tabs/live-monitor/metric/${metric}`)}>
          {info.label} details <IonIcon icon={chevronForward} />
        </span>
      </div>
    </div>
  );
};

export default TrendCard;
