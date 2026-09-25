import {
  thermometerOutline, waterOutline, leafOutline, sunnyOutline, flaskOutline, cloudOutline, speedometerOutline,
  bulbOutline, cogOutline, rainyOutline, gitBranchOutline, sync, beakerOutline, flowerOutline,
} from 'ionicons/icons';
import type { MetricKey, MetricStatus } from '../providers/types';

export const METRIC_ICON: Record<MetricKey, string> = {
  temperature: thermometerOutline, humidity: cloudOutline, soil_moisture: leafOutline, light: sunnyOutline,
  co2: cloudOutline, ph: flaskOutline, ec: beakerOutline, water_level: waterOutline, water_temperature: thermometerOutline,
  water_flow: speedometerOutline, hopper_weight: flowerOutline,
};

export const ACTUATOR_ICON: Record<string, string> = {
  irrigation: waterOutline, pump: cogOutline, valve_fog: rainyOutline, valve_drip: waterOutline, valve_sprinkler: rainyOutline,
  servo_main: gitBranchOutline, servo_diverter: gitBranchOutline, fan_exhaust: sync, fan_enclosure: sync, lights: bulbOutline,
  auger: flowerOutline,
};

export const statusColor = (s: MetricStatus) => s === 'ok' ? '#22c55e' : s === 'warn' ? '#f59e0b' : s === 'crit' ? '#ef4444' : '#94a3b8';
export const statusWord = (s: MetricStatus) => s === 'ok' ? 'In range' : s === 'warn' ? 'Watch' : s === 'crit' ? 'Out of range' : 'No data';
export const statusPill = (s: MetricStatus) => s === 'ok' ? 'sg-pill-ok' : s === 'warn' ? 'sg-pill-warn' : s === 'crit' ? 'sg-pill-crit' : 'sg-pill-idle';

/** Where a value sits in its band, 0–100 (for bar fills). */
export function bandPosition(v: number | null, band: { min: number; max: number } | null, fallbackMax = 100): number {
  if (v === null) return 0;
  if (!band) return Math.max(0, Math.min(100, (v / fallbackMax) * 100));
  const lo = band.min - (band.max - band.min) * 0.5;
  const hi = band.max + (band.max - band.min) * 0.5;
  return Math.max(2, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}
