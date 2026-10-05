import { DemoController, bandsOf } from './demoEngine';
import { describeChange, presetDiff } from '../providers/presets';
import type { PresetBands } from '../contract/types';

const lettuce = (d: DemoController): PresetBands => {
  const b = bandsOf(d.thresholds);
  for (const st of Object.keys(b)) {
    b[st].soil_moisture = { min: 65, max: 85, deadband: 4 };
    b[st].temperature = { min: 16, max: 24, deadband: 1 };
  }
  return b;
};

describe('plant presets (demo controller)', () => {
  test('starts with the built-in petchay preset active and unmodified', () => {
    const d = new DemoController('growth');
    const l = d.presetList();
    expect(l.presets.map(p => p.id)).toEqual(['petchay']);
    expect(l.active).toEqual({ id: 'petchay', name: 'Petchay (default)', modified: false });
    expect(Object.keys(l.presets[0].bands)).toEqual(['seedling', 'growth', 'mature']);
  });

  test('apply rewrites all three stages and marks the preset active', () => {
    const d = new DemoController('growth');
    const p = d.createPreset({ name: 'Lettuce', bands: lettuce(d) });
    const r = d.applyPreset(p.id);
    expect(r.changed).toBe(6);
    expect(r.active).toEqual({ id: p.id, name: 'Lettuce', modified: false });
    for (const st of ['seedling', 'growth', 'mature']) {
      expect(d.thresholds[st].find(t => t.parameter === 'soil_moisture')).toMatchObject({ min: 65, max: 85, deadband: 4 });
    }
    expect(d.audit[0]).toMatchObject({ action: 'preset_applied', target: `preset:${p.id}` });
    expect(d.applyPreset('petchay').changed).toBe(6);
  });

  test('editing a band marks the preset modified; editing it back clears that', () => {
    const d = new DemoController('growth');
    d.putThresholds('growth', [{ parameter: 'humidity', min: 62, max: 80 }]);
    expect(d.activePreset()?.modified).toBe(true);
    d.putThresholds('growth', [{ parameter: 'humidity', min: 60, max: 80 }]);
    expect(d.activePreset()?.modified).toBe(false);
  });

  test('built-in is protected, names are unique, bad bands are refused', () => {
    const d = new DemoController('growth');
    expect(() => d.editPreset('petchay', { name: 'x' })).toThrow(/built-in/);
    expect(() => d.deletePreset('petchay')).toThrow(/built-in/);
    d.createPreset({ name: 'Lettuce', bands: lettuce(d) });
    expect(() => d.createPreset({ name: ' lettuce', bands: lettuce(d) })).toThrow(/already exists/);
    const bad = lettuce(d);
    bad.growth.ph = { min: 7, max: 6, deadband: 0.2 };
    expect(() => d.createPreset({ name: 'Bad', bands: bad })).toThrow(/min must be below max/);
  });

  test('saving edited thresholds makes the new preset active', () => {
    const d = new DemoController('growth');
    d.putThresholds('growth', [{ parameter: 'humidity', min: 62, max: 80 }]);
    const p = d.createPreset({ name: 'Petchay, drier' });
    expect(d.activePreset()).toEqual({ id: p.id, name: 'Petchay, drier', modified: false });
    d.createPreset({ name: 'Copy' });
    expect(d.activePreset()?.id).toBe(p.id);
  });

  test('save current, rename, delete the active one', () => {
    const d = new DemoController('growth');
    d.putThresholds('mature', [{ parameter: 'ec', min: 1.6, max: 2.2 }]);
    const p = d.createPreset({ name: 'Petchay, richer feed' });
    expect(p.bands.mature.ec.min).toBe(1.6);
    d.applyPreset(p.id);
    d.editPreset(p.id, { name: 'Petchay EC+', note: 'trial' });
    expect(d.activePreset()?.name).toBe('Petchay EC+');
    d.deletePreset(p.id);
    expect(d.activePreset()).toBeNull();
    expect(d.thresholds.mature.find(t => t.parameter === 'ec')?.min).toBe(1.6);
  });
});

describe('preset helpers', () => {
  test('presetDiff lists only bands that change', () => {
    const cur: PresetBands = { growth: { ph: { min: 5.5, max: 6.5, deadband: 0.2 }, ec: { min: 1.2, max: 1.8, deadband: 0.2 } } };
    const next: PresetBands = { growth: { ph: { min: 5.5, max: 6.5, deadband: 0.2 }, ec: { min: 1.0, max: 1.6, deadband: 0.2 } } };
    expect(presetDiff(cur, next)).toEqual([{ stage: 'growth', param: 'ec', from: cur.growth.ec, to: next.growth.ec }]);
  });

  test('describeChange reads both controller and demo threshold details', () => {
    const base = { id: 1, actor: 'a', occurred_at: '2026-10-05T00:00:00Z', target: 'threshold:growth:ph' };
    expect(describeChange({ ...base, action: 'threshold_updated', detail: { parameter: 'ph', new: { min: 5.6, max: 6.4 } } }))
      .toBe('growth · ph → 5.6–6.4');
    expect(describeChange({ ...base, action: 'threshold_updated', detail: { parameter: 'ph', min: 5.6, max: 6.4 } }))
      .toBe('growth · ph → 5.6–6.4');
    expect(describeChange({ ...base, action: 'preset_applied', target: 'preset:p-1', detail: { name: 'Lettuce', changed: 6 } }))
      .toBe('Applied preset Lettuce (6 bands changed)');
  });
});
