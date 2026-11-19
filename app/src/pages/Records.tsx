import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IonPage, IonContent, IonSegment, IonSegmentButton, IonLabel, IonButton } from '@ionic/react';
import PersistentHeader from '../components/PersistentHeader';
import StatusBanner from '../components/StatusBanner';
import LineChart, { ChartSeries } from '../components/LineChart';
import PillScroller from '../components/PillScroller';
import { RANGES, RangeId } from '../components/chartScale';
import { PerSensor, useHistoryChart } from '../components/useHistoryChart';
import { useGreenhouse } from '../providers/GreenhouseProvider';
import { METRIC_INFO } from '../providers/metrics';
import type { MetricKey } from '../providers/types';
import type { AuditEntry, EventEntry, FertilizerReport, WaterDay } from '../contract/types';
import { fmtDateTime, toCsv } from '../components/format';
import ExportPanel, { ExportPreset } from '../components/ExportPanel';
import { csvBlob, saveFile } from '../components/saveFile';
import { Skeleton } from '../components/motion';
import { commandRefusal, doseStop, eventAction, plainDetail } from '../contract/codes';

type Tab = 'environment' | 'water' | 'fertilizer' | 'activity';
const PARAMS: MetricKey[] = ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'water_level'];
const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#14b8a6', '#ef4444', '#64748b'];
// Commands name the device; a refused one gives the reason in words, as the toast did.
const auditRow = (a: AuditEntry, names: Record<string, string>): { what: string; detail: string; warn: boolean } => {
  const d = (a.detail ?? {}) as { action?: string; reason?: string | null; message?: string | null };
  const m = a.action.match(/^command_(\w+)$/);
  if (m && a.target.startsWith('actuator:')) {
    const id = a.target.slice('actuator:'.length);
    const name = id === 'all' ? 'Emergency stop' : names[id] ?? id;
    if (m[1] === 'rejected' || m[1] === 'expired') {
      const r = commandRefusal(d.reason, d.message, name, id === 'all' ? 'ESTOP' : d.action ?? '');
      return { what: r.title, detail: r.text, warn: true };
    }
    return { what: `${name} · ${eventAction(`CMD_${d.action ?? ''}`)}${m[1] === 'simulated' ? ' (simulated)' : ''}`, detail: d.message ?? '', warn: false };
  }
  return { what: a.action.replace(/_/g, ' '), detail: a.target, warn: false };
};
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const Records: React.FC = () => {
  const gh = useGreenhouse();
  const [tab, setTab] = useState<Tab>('environment');
  const [param, setParam] = useState<MetricKey>('soil_moisture');
  const [rangeId, setRangeId] = useState<RangeId>('24h');
  const [water, setWater] = useState<WaterDay[]>([]);
  const [waterDays, setWaterDays] = useState(7);
  const [fert, setFert] = useState<FertilizerReport | null>(null);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    const done = () => { if (alive) setLoading(false); };
    const fail = (e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : 'Could not load.'); };
    if (tab === 'environment') {
      done();   // the chart loads its own history (useHistoryChart)
    } else if (tab === 'water') {
      gh.data.waterUsage(waterDays).then(r => alive && setWater(r)).catch(fail).finally(done);
    } else if (tab === 'fertilizer') {
      gh.data.fertilizer(30).then(r => alive && setFert(r)).catch(fail).finally(done);
    } else {
      Promise.all([gh.data.events(200), gh.data.audit(200)])
        .then(([e, a]) => { if (alive) { setEvents(e); setAudit(a); } }).catch(fail).finally(done);
    }
    return () => { alive = false; };
  }, [gh.data, tab, waterDays]);

  // One line per sensor.
  const toSeries = useCallback((data: PerSensor): ChartSeries[] => Object.keys(data).sort().map((sid, i) => ({
    name: sid, color: COLORS[i % COLORS.length], points: data[sid],
  })), []);
  const hc = useHistoryChart(gh.data.history, { type: param }, param, rangeId, toSeries);
  const hist = hc.result;

  const activity = useMemo(() => {
    const names = Object.fromEntries(gh.meta.actuators.map(a => [a.id, a.name]));
    return [
    ...events.map(e => ({ at: e.occurred_at, kind: 'device', who: e.issued_by, warn: e.action === 'SUPPRESSED' || /— stopped:|aborted/.test(e.reason ?? ''),
      what: `${gh.meta.actuators.find(a => a.id === e.actuator_id)?.name ?? e.actuator_id} · ${eventAction(e.action)}`,
      // Lines recorded before 11 Oct 2026 can end in a code ("— aborted LOAD_CELL_FAULT", "deferred: MIN_OFF_TIME"); show words.
      detail: `${plainDetail((e.reason ?? '').replace(/— aborted ([A-Z_]+)$/, (_m, c: string) => `— stopped: ${doseStop(c).title.toLowerCase()}`))} (${e.source})` })),
    ...audit.map(a => ({ at: a.occurred_at, kind: 'audit', who: a.actor, ...auditRow(a, names) })),
  ].sort((a, b) => b.at.localeCompare(a.at)); }, [events, audit, gh.meta.actuators]);

  // "This view as CSV": what the page shows, made in the app (also in demo mode).
  const exportView = async () => {
    let name = '', rows: Record<string, unknown>[] = [];
    if (tab === 'environment' && hist) {
      rows = Object.entries(hist.series).flatMap(([sid, pts]) => pts.map(p => ({ sensor_id: sid, ts: p.ts, value: p.value, min: p.min ?? '', max: p.max ?? '', samples: p.n ?? '', quality: p.quality ?? '' })));
      name = `${param}-${rangeId}-${hist.resolution}-${stamp()}.csv`;
    } else if (tab === 'water') { rows = water as unknown as Record<string, unknown>[]; name = `water-usage-${stamp()}.csv`; }
    else if (tab === 'fertilizer' && fert) { rows = fert.doses as unknown as Record<string, unknown>[]; name = `fertilizer-doses-${stamp()}.csv`; }
    else if (tab === 'activity') { rows = activity; name = `activity-${stamp()}.csv`; }
    if (!rows.length) throw new Error('Nothing shown here yet to save.');
    await saveFile(name, csvBlob(toCsv(rows)));
  };
  // The export panel starts from what the page shows.
  const preset = useMemo<ExportPreset>(() => (
    tab === 'environment' ? { datasets: ['readings'], types: [param], period: rangeId === '6h' || rangeId === '24h' ? '24h' : rangeId === '7d' ? '7d' : '30d' }
      : tab === 'water' ? { datasets: ['water'], period: waterDays === 7 ? '7d' : '30d' }
        : tab === 'fertilizer' ? { datasets: ['fertilizer'], period: '30d' }
          : { datasets: ['activity', 'alerts'], period: '7d' }), [tab, param, rangeId, waterDays]);

  const maxL = Math.max(1, ...water.map(w => w.litres));
  const info = METRIC_INFO[param];
  const band = gh.thresholds[param];

  return (
    <IonPage>
      <PersistentHeader showBack defaultHref="/tabs/more" />
      <IonContent className="ion-padding">
        <StatusBanner />
        <div className="sg-row-between" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sg-text)' }}>Records</div>
          <IonButton size="small" fill={exporting ? 'solid' : 'outline'} onClick={() => setExporting(x => !x)}>Export</IonButton>
        </div>
        {exporting && <ExportPanel preset={preset} onThisView={exportView} onClose={() => setExporting(false)} />}
        <IonSegment value={tab} onIonChange={e => setTab(e.detail.value as Tab)} scrollable style={{ marginBottom: 12 }}>
          <IonSegmentButton value="environment"><IonLabel>Sensors</IonLabel></IonSegmentButton>
          <IonSegmentButton value="water"><IonLabel>Water</IonLabel></IonSegmentButton>
          <IonSegmentButton value="fertilizer"><IonLabel>Fertilizer</IonLabel></IonSegmentButton>
          <IonSegmentButton value="activity"><IonLabel>Activity</IonLabel></IonSegmentButton>
        </IonSegment>
        {(loading || (tab === 'environment' && hc.loading)) && <Skeleton h={4} r={2} style={{ marginBottom: 10 }} />}
        {(err || (tab === 'environment' && hc.err)) && <div className="sg-banner-offline" style={{ marginBottom: 12 }}>{tab === 'environment' ? hc.err : err}</div>}

        {tab === 'environment' && (
          <div className="sg-card">
            <PillScroller activeKey={param} style={{ marginBottom: 10 }}>
              {PARAMS.filter(p => gh.metrics[p].installed).map(p => (
                <span key={p} className={`sg-filter-pill ${param === p ? 'active' : ''}`} onClick={() => setParam(p)}>{METRIC_INFO[p].short}</span>
              ))}
            </PillScroller>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {RANGES.map(r => <span key={r.id} className={`sg-filter-pill ${rangeId === r.id ? 'active' : ''}`} onClick={() => setRangeId(r.id)}>{r.id}</span>)}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--sg-text)', marginBottom: 6 }}>{info.label} · each sensor</div>
            <LineChart layers={hc.layers} full={hc.full} view={hc.view} onViewChange={hc.setView} minSpan={hc.range.minSpan}
              resetKey={hc.resetKey} updated={{ at: hc.updatedAt, everyMs: hc.range.refresh }}
              rangeLabel={`last ${hc.range.id}`} band={band ? { min: band.min, max: band.max } : null} unit={` ${info.unit}`} digits={info.digits} height={180} />
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 6 }}>
              Raw readings are kept 7 days (pH 30 days); older data is kept as 15-minute averages. “This view as CSV” saves the range as loaded ({hc.plan.res === 'raw' ? 'raw readings' : `${hc.plan.res} averages`}); Export makes a file for any period.
            </div>
          </div>
        )}

        {tab === 'water' && (
          <div className="sg-card">
            <div className="sg-row-between" style={{ marginBottom: 10 }}>
              <div className="sg-section-title" style={{ marginBottom: 0 }}>Estimated water use</div>
              <div className="sg-row sg-gap-4">
                {[7, 14, 30].map(d => <span key={d} className={`sg-filter-pill ${waterDays === d ? 'active' : ''}`} onClick={() => setWaterDays(d)}>{d}d</span>)}
              </div>
            </div>
            {water.map(w => (
              <div key={w.date} className="sg-row sg-gap-8" style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--sg-muted)', width: 70 }}>{w.date.slice(5)}</span>
                <div className="sg-bar-track" style={{ flex: 1 }}><div className="sg-bar-fill" style={{ width: `${(w.litres / maxL) * 100}%`, background: '#3b82f6' }} /></div>
                <span style={{ fontSize: 11, color: 'var(--sg-text)', width: 90, textAlign: 'right' }}>{w.litres} L · {w.pump_minutes} min</span>
              </div>
            ))}
            <div style={{ fontSize: 10, color: 'var(--sg-dim)', marginTop: 8 }}>
              {water[0]?.method ?? ''}. Total {water.reduce((a, w) => a + w.litres, 0).toFixed(1)} L over {waterDays} days.
            </div>
          </div>
        )}

        {tab === 'fertilizer' && fert && (
          <div className="sg-card">
            <div className="sg-row sg-gap-8" style={{ marginBottom: 10 }}>
              {[
                { l: 'Completed', v: `${fert.complete} of ${fert.count}` },
                { l: 'Delivered', v: `${fert.total_delivered_g} g` },
                { l: 'Mean |error|', v: fert.mean_abs_error_g !== null ? `${fert.mean_abs_error_g} g` : '—' },
              ].map(k => (
                <div key={k.l} className="sg-kpi" style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: 'var(--sg-muted)' }}>{k.l}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e' }}>{k.v}</div>
                </div>
              ))}
            </div>
            {fert.doses.map(d => (
              <div key={d.id} className="sg-row-between" style={{ padding: '7px 0', borderTop: '1px solid var(--sg-border)' }}>
                <span style={{ fontSize: 12, color: 'var(--sg-text)' }}>{fmtDateTime(d.started_at)}</span>
                <span style={{ fontSize: 12, color: d.status === 'complete' ? 'var(--sg-muted)' : '#f59e0b', textAlign: 'right' }}>
                  {d.target_g} → {d.delivered_g ?? '—'} g · {d.status === 'complete' ? 'complete' : `stopped: ${doseStop(d.reason).title.toLowerCase()}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === 'activity' && (
          <div className="sg-card">
            {activity.length === 0 && !loading && <div style={{ fontSize: 12, color: 'var(--sg-dim)' }}>Nothing recorded yet.</div>}
            {activity.slice(0, 150).map((a, i) => (
              <div key={i} className={`sg-timeline-entry ${a.warn ? 'warn' : ''}`}>
                <div className="sg-row-between">
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--sg-text)' }}>{a.what}</span>
                  <span style={{ fontSize: 10, color: 'var(--sg-dim)' }}>{fmtDateTime(a.at)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--sg-muted)' }}>{a.detail} · {a.who}</div>
              </div>
            ))}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default Records;
