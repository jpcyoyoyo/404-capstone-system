import { describe, expect, it } from 'vitest';
import { REGISTRY_META } from '../contract/registry.generated';
import { addDays, advance, computeSchedule, defaultDays, diffDays, scheduleLine } from './stageSchedule';

const stages = REGISTRY_META.stages;
const days = defaultDays(stages);   // seedling 14, growth 16, mature 10

describe('growth-stage schedule (same rules as controller/greenhouse/stages.py)', () => {
  it('uses the registry defaults', () => {
    expect(days).toEqual({ seedling: 14, growth: 16, mature: 10 });
  });

  it('counts days and the next change', () => {
    const s = computeSchedule(stages, days, 'auto', 'seedling', '2026-10-13', '2026-10-21');
    expect(s.day).toBe(9);
    expect(s.next_stage_id).toBe('growth');
    expect(s.next_change_on).toBe('2026-10-27');
    expect(s.crop_days).toBe(40);
    expect(scheduleLine(s, id => id)).toBe('Day 9 of 14 · growth starts 27 Oct');
  });

  it('advances through every finished stage, anchored to the planned dates', () => {
    const r = advance(stages, days, 'seedling', '2026-10-13', addDays('2026-10-13', 34));
    expect(r.moves).toEqual([['seedling', 'growth'], ['growth', 'mature']]);
    expect(r.stageId).toBe('mature');
    expect(r.startedOn).toBe('2026-11-12');
    expect(advance(stages, days, 'seedling', '2026-10-13', '2026-10-26').moves).toEqual([]);   // day 14
  });

  it('never advances past the last stage; reports harvest due', () => {
    expect(advance(stages, days, 'mature', '2026-10-01', '2026-12-01').moves).toEqual([]);
    const s = computeSchedule(stages, days, 'auto', 'mature', '2026-10-01', '2026-10-15');
    expect(s.harvest_due).toBe(true);
  });

  it('manual mode has no automatic change date', () => {
    expect(computeSchedule(stages, days, 'manual', 'growth', '2026-10-01', '2026-10-05').next_change_on).toBeNull();
    expect(diffDays('2026-10-01', '2026-11-01')).toBe(31);
  });
});
