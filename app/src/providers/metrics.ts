// Turns raw per-sensor readings into the greenhouse-level metrics the pages show.
// Same aggregation as the controller (controller/greenhouse/control/aggregate.py):
// median of VALID readings per zone, then the mean of the zone medians.
import type { GreenhouseMeta, Reading, Threshold, ZoneSummary } from '../contract/types';
import type { MetricKey, MetricStatus, MetricView } from './types';

export const METRIC_KEYS: MetricKey[] = [
  'temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'ec',
  'water_level', 'water_temperature', 'water_flow', 'hopper_weight',
];

export const METRIC_INFO: Record<MetricKey, { label: string; short: string; unit: string; digits: number }> = {
  temperature:       { label: 'Air temperature',   short: 'Temp',       unit: '°C',    digits: 1 },
  humidity:          { label: 'Relative humidity', short: 'Humidity',   unit: '%',     digits: 0 },
  soil_moisture:     { label: 'Soil moisture',     short: 'Soil',       unit: '%',     digits: 0 },
  light:             { label: 'Light intensity',   short: 'Light',      unit: 'lux',   digits: 0 },
  co2:               { label: 'CO₂',               short: 'CO₂',        unit: 'ppm',   digits: 0 },
  ph:                { label: 'Nutrient pH',       short: 'pH',         unit: 'pH',    digits: 2 },
  ec:                { label: 'Nutrient EC',       short: 'EC',         unit: 'mS/cm', digits: 2 },
  water_level:       { label: 'Reservoir level',   short: 'Water',      unit: '%',     digits: 0 },
  water_temperature: { label: 'Water temperature', short: 'Water temp', unit: '°C',    digits: 1 },
  water_flow:        { label: 'Water flow',        short: 'Flow',       unit: 'L/min', digits: 1 },
  hopper_weight:     { label: 'Fertilizer hopper', short: 'Hopper',     unit: 'g',     digits: 0 },
};

/** Route-friendly ids used by /tabs/live-monitor/metric/:id (older links used "moisture"). */
export function metricFromRoute(id: string): MetricKey | null {
  if (id === 'moisture') return 'soil_moisture';
  return (METRIC_KEYS as string[]).includes(id) ? (id as MetricKey) : null;
}

export function formatMetric(key: MetricKey, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const d = METRIC_INFO[key].digits;
  if (key === 'light') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toString();
  return v.toFixed(d);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Zone summaries from readings (used by demo, and by live between controller status messages). */
export function summarise(meta: GreenhouseMeta, readings: Record<string, Reading>): Record<string, ZoneSummary> {
  const out: Record<string, ZoneSummary> = {};
  for (const key of METRIC_KEYS) {
    const sensors = meta.sensors.filter(s => s.type === key && s.installed);
    const zones: ZoneSummary['zones'] = {};
    const byZone = new Map<number, number[]>();
    for (const s of sensors) {
      const z = zones[String(s.zone)] ?? (zones[String(s.zone)] = { median: null, valid: 0, total: 0 });
      z.total += 1;
      const r = readings[s.id];
      if (r && r.quality === 'VALID' && r.value !== null) {
        z.valid += 1;
        byZone.set(s.zone, [...(byZone.get(s.zone) ?? []), r.value]);
      }
    }
    const medians: number[] = [];
    for (const [z, vals] of byZone) {
      const m = median(vals);
      zones[String(z)].median = Math.round(m * 1000) / 1000;
      medians.push(m);
    }
    out[key] = {
      value: medians.length ? Math.round((medians.reduce((a, b) => a + b, 0) / medians.length) * 1000) / 1000 : null,
      manual_required: [], zones,
    };
  }
  return out;
}

export function statusFor(key: MetricKey, v: number | null, band: MetricView['band']): MetricStatus {
  if (v === null) return 'unknown';
  if (band) {
    const span = Math.max(band.max - band.min, 1e-9);
    const margin = Math.max(band.deadband * 2, span * 0.15);
    if (v < band.min - margin || v > band.max + margin) return 'crit';
    if (v < band.min || v > band.max) return 'warn';
    return 'ok';
  }
  switch (key) {
    case 'water_level': return v < 15 ? 'crit' : v < 30 ? 'warn' : 'ok';
    case 'hopper_weight': return v < 50 ? 'crit' : v < 150 ? 'warn' : 'ok';
    case 'water_temperature': return v > 32 || v < 15 ? 'warn' : 'ok';
    default: return 'ok';
  }
}

export function buildMetrics(
  meta: GreenhouseMeta,
  readings: Record<string, Reading>,
  zones: Record<string, ZoneSummary>,
  thresholds: Record<string, Threshold>,
  history: Record<string, number[]>,
): Record<MetricKey, MetricView> {
  const out = {} as Record<MetricKey, MetricView>;
  for (const key of METRIC_KEYS) {
    const info = METRIC_INFO[key];
    const sensors = meta.sensors.filter(s => s.type === key);
    const installed = sensors.some(s => s.installed);
    const z = zones[key];
    const t = thresholds[key];
    const band = t ? { min: t.min, max: t.max, deadband: t.deadband } : null;
    const value = z?.value ?? null;
    let note: string | null = null;
    if (!installed) note = 'Not installed';
    else if (value === null) {
      const qs = sensors.map(s => readings[s.id]?.quality).filter(Boolean);
      note = qs.includes('WARMING') ? 'Warming up'
        : qs.includes('UNCALIBRATED') ? 'Needs calibration'
        : qs.includes('STALE') ? 'No recent reading'
        : qs.length ? 'No valid reading' : 'Waiting for data';
    } else if (z && z.manual_required.length) note = `Zone ${z.manual_required.join(', ')} needs manual control`;
    out[key] = {
      key, label: info.label, unit: sensors[0]?.unit || info.unit,
      value, status: installed ? statusFor(key, value, band) : 'unknown', note, installed,
      zones: z?.zones ?? {}, manualRequired: z?.manual_required ?? [], band,
      history: history[key] ?? [],
    };
  }
  return out;
}

/** Appends the current metric values to ring buffers (max 30 points). */
export function pushHistory(prev: Record<string, number[]>, zones: Record<string, ZoneSummary>, max = 30): Record<string, number[]> {
  const next: Record<string, number[]> = { ...prev };
  for (const key of METRIC_KEYS) {
    const v = zones[key]?.value;
    if (v === null || v === undefined) continue;
    next[key] = [...(prev[key] ?? []), v].slice(-max);
  }
  return next;
}

export function thresholdMap(list: Threshold[]): Record<string, Threshold> {
  return Object.fromEntries(list.map(t => [t.parameter, t]));
}

export function newCmdId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
