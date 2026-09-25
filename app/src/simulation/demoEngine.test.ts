import { DemoController } from './demoEngine';
import { summarise, buildMetrics, thresholdMap, statusFor } from '../providers/metrics';

const cmd = (actuator_id: string, action: 'ON' | 'OFF' | 'AUTO' | 'DOSE' | 'ESTOP', extra: Record<string, unknown> = {}) =>
  ({ cmd_id: `c-${Math.random()}`, actuator_id, action, ts: new Date().toISOString(), ...extra });

describe('demo controller', () => {
  test('publishes a reading for every installed sensor, with CO2 warming first', () => {
    const d = new DemoController('growth');
    const installed = d.meta.sensors.filter(s => s.installed).map(s => s.id).sort();
    expect(Object.keys(d.readings).sort()).toEqual(installed);
    expect(d.readings.co2_01.quality).toBe('WARMING');
    expect(d.readings.temp_z1_01.quality).toBe('VALID');
  });

  test('every accepted command is SIMULATED and idempotent by cmd_id', () => {
    const d = new DemoController('growth');
    const c = cmd('lights', 'ON', { duration_s: 60 });
    const a = d.command(c);
    expect(a.status).toBe('SIMULATED');
    expect(d.snapshot().actuators.lights.on).toBe(true);
    expect(d.snapshot().actuators.lights.mode).toBe('MANUAL');
    expect(d.command(c).replayed).toBe(true);
  });

  test('refuses devices that are not installed, and expired commands', () => {
    const d = new DemoController('growth');
    expect(d.command(cmd('fan_exhaust', 'ON')).reason).toBe('NOT_INSTALLED');
    const old = { ...cmd('lights', 'ON'), ts: new Date(Date.now() - 120_000).toISOString() };
    expect(d.command(old).status).toBe('EXPIRED');
  });

  test('manual irrigation opens the chosen valve and runs the pump', () => {
    const d = new DemoController('growth');
    d.command(cmd('irrigation', 'ON', { circuit: 'sprinkler', duration_s: 120 }));
    const a = d.snapshot().actuators;
    expect(a.irrigation.on).toBe(true);
    expect(a.irrigation.circuit).toBe('sprinkler');
    expect(a.valve_sprinkler.on).toBe(true);
    expect(a.valve_drip.on).toBe(false);
    expect(a.pump.on).toBe(true);
    d.command(cmd('irrigation', 'OFF', { duration_s: 60 }));
    expect(d.snapshot().actuators.pump.on).toBe(false);
  });

  test('a dose runs to the target and is recorded; stopping aborts it', () => {
    const d = new DemoController('growth');
    const before = d.doses.length;
    expect(d.command(cmd('auger', 'DOSE', { target_g: 12 })).status).toBe('SIMULATED');
    expect(d.command(cmd('auger', 'DOSE', { target_g: 5 })).reason).toBe('DOSING');
    for (let i = 0; i < 10; i++) d.tick(2);
    expect(d.doses.length).toBe(before + 1);
    expect(d.doses[0].status).toBe('complete');
    expect(Math.abs(d.doses[0].error_g ?? 99)).toBeLessThan(1);
    d.command(cmd('auger', 'DOSE', { target_g: 40 }));
    d.tick(2);
    d.command(cmd('auger', 'OFF'));
    expect(d.doses[0].reason).toBe('STOPPED');
  });

  test('emergency stop turns everything off and holds it manual', () => {
    const d = new DemoController('growth');
    d.command(cmd('lights', 'ON'));
    d.command(cmd('all', 'ESTOP'));
    const a = d.snapshot().actuators;
    expect(Object.values(a).some(x => x.on)).toBe(false);
    expect(a.lights.mode).toBe('MANUAL');
    expect(d.alertsList('open').some(x => x.code === 'ESTOP')).toBe(true);
  });

  test('threshold edits bump the version and are audited', () => {
    const d = new DemoController('growth');
    const out = d.putThresholds('growth', [{ parameter: 'soil_moisture', min: 50, max: 70 }]);
    const t = out.find(x => x.parameter === 'soil_moisture')!;
    expect([t.min, t.max, t.version]).toEqual([50, 70, 2]);
    expect(d.audit[0].action).toBe('threshold_updated');
  });
});

describe('metrics', () => {
  test('median per zone, mean of zones, only VALID readings count', () => {
    const d = new DemoController('growth');
    const r = { ...d.readings };
    r.soil_z1_01 = { ...r.soil_z1_01, value: 10, quality: 'VALID' };
    r.soil_z1_02 = { ...r.soil_z1_02, value: 20, quality: 'VALID' };
    r.soil_z1_03 = { ...r.soil_z1_03, value: 99, quality: 'INVALID' };
    r.soil_z2_01 = { ...r.soil_z2_01, value: 30, quality: 'VALID' };
    r.soil_z2_02 = { ...r.soil_z2_02, value: 40, quality: 'VALID' };
    r.soil_z2_03 = { ...r.soil_z2_03, value: 50, quality: 'VALID' };
    const z = summarise(d.meta, r).soil_moisture;
    expect(z.zones['1']).toEqual({ median: 15, valid: 2, total: 3 });
    expect(z.zones['2'].median).toBe(40);
    expect(z.value).toBe(27.5);
    const m = buildMetrics(d.meta, r, { soil_moisture: z }, thresholdMap(d.thresholds.growth), {});
    expect(m.soil_moisture.status).toBe('crit');
    expect(m.ec.installed).toBe(false);
  });

  test('status bands', () => {
    const band = { min: 60, max: 75, deadband: 5 };
    expect(statusFor('soil_moisture', 65, band)).toBe('ok');
    expect(statusFor('soil_moisture', 58, band)).toBe('warn');
    expect(statusFor('soil_moisture', 40, band)).toBe('crit');
    expect(statusFor('soil_moisture', null, band)).toBe('unknown');
    expect(statusFor('water_level', 10, null)).toBe('crit');
  });
});
