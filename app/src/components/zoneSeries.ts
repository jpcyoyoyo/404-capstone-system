import type { ChartSeries } from './LineChart';
import { PerSensor, mergeSensors } from './useHistoryChart';
import type { GreenhouseMeta } from '../contract/types';

export const ZONE_COLORS: Record<string, string> = { '0': '#14b8a6', '1': '#22c55e', '2': '#3b82f6' };

/** One chart line per zone: the zone's sensors averaged group by group, with the zone's lowest
 *  and highest reading (used by the metric page and the desktop overview's trend card). */
export function zoneSeries(meta: Pick<GreenhouseMeta, 'sensors' | 'zones'>, data: PerSensor): ChartSeries[] {
  const byZone = new Map<number, PerSensor[string][]>();
  for (const [sid, pts] of Object.entries(data)) {
    const s = meta.sensors.find(x => x.id === sid);
    if (!s || !pts.length) continue;
    byZone.set(s.zone, [...(byZone.get(s.zone) ?? []), pts]);
  }
  return [...byZone.entries()].sort((a, b) => a[0] - b[0]).map(([z, lists]) => ({
    name: meta.zones.find(x => x.id === z)?.name ?? `Zone ${z}`,
    color: ZONE_COLORS[String(z)] ?? '#a855f7',
    points: mergeSensors(lists),
  }));
}
