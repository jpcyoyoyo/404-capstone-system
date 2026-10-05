// Plant-preset helpers shared by the Thresholds page and its tests.
import type { AuditEntry, Band, PresetBands } from '../contract/types';

/** Every band that would change, per stage, if `next` replaced `cur`. */
export function presetDiff(cur: PresetBands, next: PresetBands): { stage: string; param: string; from?: Band; to: Band }[] {
  const out: { stage: string; param: string; from?: Band; to: Band }[] = [];
  for (const [stage, params] of Object.entries(next)) {
    for (const [param, to] of Object.entries(params)) {
      const from = cur[stage]?.[param];
      if (!from || from.min !== to.min || from.max !== to.max || from.deadband !== to.deadband) out.push({ stage, param, from, to });
    }
  }
  return out;
}


export const SHOWN_ACTIONS = new Set(['threshold_updated', 'stage_changed', 'preset_applied', 'preset_created', 'preset_updated', 'preset_deleted']);

/** One line for the "Recent changes" list. */
export function describeChange(a: AuditEntry): string {
  const d = (a.detail ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case 'stage_changed': return `Stage ${String(d.old ?? '?')} → ${String(d.new ?? '?')}`;
    case 'preset_applied': return `Applied preset ${String(d.name ?? '?')}${typeof d.changed === 'number' ? ` (${d.changed} bands changed)` : ''}`;
    case 'preset_created': return `Saved preset ${String(d.name ?? '?')}`;
    case 'preset_updated': return `Edited preset ${String(d.name ?? '?')}`;
    case 'preset_deleted': return `Deleted preset ${String(d.name ?? '?')}`;
    default: {
      // controller: {parameter, old, new: {min, max}}; demo: {parameter, min, max}
      const n = (d.new ?? d) as Record<string, unknown>;
      return `${a.target.split(':').slice(1).join(' · ')} → ${String(n.min ?? '')}–${String(n.max ?? '')}`;
    }
  }
}

