// Growth-stage schedule arithmetic, mirroring controller/greenhouse/stages.py. Used by the demo
// engine (the controller computes it in live mode) and for wording on the screens.
import type { StageDef, StageSchedule } from '../contract/types';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date of a timestamp, YYYY-MM-DD. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const toUtc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };

export function addDays(d: string, n: number): string {
  const t = new Date(toUtc(d) + n * 864e5);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from a to b (b − a). */
export const diffDays = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 864e5);

/** "27 Oct" from YYYY-MM-DD. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [, m, dd] = d.split('-').map(Number);
  return `${dd} ${MONTHS[m - 1] ?? ''}`;
}

export function defaultDays(stages: StageDef[]): Record<string, number> {
  return Object.fromEntries(stages.map(s => [s.id, s.days ?? 14]));
}

export function computeSchedule(stages: StageDef[], days: Record<string, number>, mode: 'auto' | 'manual',
  stageId: string, startedOn: string, today: string): StageSchedule {
  const order = [...stages].sort((a, b) => a.sequence - b.sequence).map(s => s.id);
  const idx = Math.max(0, order.indexOf(stageId));
  const length = days[stageId] ?? 14;
  const day = Math.max(1, diffDays(startedOn, today) + 1);
  const next = idx + 1 < order.length ? order[idx + 1] : null;
  const endsOn = addDays(startedOn, length - 1);
  const before = order.slice(0, idx).reduce((n, s) => n + (days[s] ?? 0), 0);
  return {
    mode, stage_id: stageId, started_on: startedOn, day, stage_days: length, days_left: Math.max(0, length - day),
    ends_on: endsOn, next_stage_id: next, next_change_on: mode === 'auto' && next ? addDays(endsOn, 1) : null,
    crop_day: before + day, crop_days: order.reduce((n, s) => n + (days[s] ?? 0), 0),
    harvest_due: next === null && day > length, overdue: day > length, days: { ...days }, order,
  };
}

/** Automatic stage change: every stage whose days are over, anchored to the planned dates. */
export function advance(stages: StageDef[], days: Record<string, number>, stageId: string, startedOn: string, today: string):
  { stageId: string; startedOn: string; moves: [string, string][] } {
  const order = [...stages].sort((a, b) => a.sequence - b.sequence).map(s => s.id);
  const moves: [string, string][] = [];
  let id = stageId, start = startedOn;
  while (order.indexOf(id) >= 0 && order.indexOf(id) + 1 < order.length) {
    const nextStart = addDays(start, days[id] ?? 14);
    if (diffDays(nextStart, today) < 0) break;
    const nxt = order[order.indexOf(id) + 1];
    moves.push([id, nxt]);
    id = nxt; start = nextStart;
  }
  return { stageId: id, startedOn: start, moves };
}

/** One-line summary, e.g. "Day 9 of 16 · Mature starts 27 Oct". */
export function scheduleLine(s: StageSchedule, nameOf: (id: string) => string): string {
  const head = `Day ${s.day} of ${s.stage_days}`;
  if (s.harvest_due) return `${head} · harvest due`;
  if (s.mode === 'manual') return `${head} · manual stage change${s.overdue ? ' · days are up' : ''}`;
  return s.next_stage_id && s.next_change_on ? `${head} · ${nameOf(s.next_stage_id)} starts ${shortDate(s.next_change_on)}` : head;
}
