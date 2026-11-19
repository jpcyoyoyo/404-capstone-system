// Periods and size estimates for Records → Export (ExportPanel.tsx).

export type PeriodId = 'today' | '24h' | '7d' | '30d' | '90d' | 'custom';

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The period as [from, to), from the device's clock; custom dates run from the start of `from` to the end of `to`. */
export function periodRange(id: PeriodId, custom: { from: string; to: string }, now = new Date()): [Date, Date] {
  const day = 86_400_000;
  if (id === 'today') { const s = new Date(now); s.setHours(0, 0, 0, 0); return [s, now]; }
  if (id === 'custom') {
    const s = new Date(`${custom.from}T00:00:00`); const e = new Date(`${custom.to}T00:00:00`);
    e.setDate(e.getDate() + 1);
    return [s, e];
  }
  const n = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[id];
  return [new Date(now.getTime() - n * day), now];
}

/** About how big a file of every reading would be (a reading every 30 s, about 75 bytes a row). */
export function rawSizeMb(sensors: number, ms: number): number {
  return Math.round((sensors * (ms / 30_000) * 75) / 1e5) / 10;
}
