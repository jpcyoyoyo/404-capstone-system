/**
 * Demo mode: an in-app stand-in for the Raspberry Pi controller.
 *
 * It speaks the same shapes as the real API (contract/types.ts) — per-sensor readings with
 * quality flags, actuator states with lockouts, alerts, events, doses — so every page works
 * identically in demo and live. Nothing here ever reaches hardware: every accepted command
 * is acknowledged as SIMULATED (Integration Plan §9.8, amended).
 */
import { DEFAULT_THRESHOLDS, REGISTRY_META } from '../contract/registry.generated';
import type {
  Ack, ActuatorState, AlertItem, AlertSeverity, AuditEntry, CalibrationBody, CalibrationEntry, CommandRequest,
  DoseItem, EventEntry, FertilizerReport, GreenhouseMeta, HistoryPoint, HistoryResult, Reading, Threshold,
  UserItem, WaterDay,
} from '../contract/types';
import type { EnergyView, HistoryQuery } from '../providers/types';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const noise = (d: number) => (Math.random() - 0.5) * 2 * d;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const iso = (ms: number) => new Date(ms).toISOString();

/** Deterministic pseudo-noise so synthetic history looks the same on every request. */
const hashNoise = (seed: string, t: number) => {
  let h = 2166136261;
  const s = `${seed}:${Math.floor(t)}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000 - 0.5;
};

const hourOf = (ms: number) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const sunFactor = (ms: number) => Math.max(0, Math.sin(Math.PI * (hourOf(ms) - 6) / 12));

interface ActInternal extends ActuatorState { manualUntilMs: number | null }

interface Dose { cmd_id: string; target: number; delivered: number; startedMs: number; issued_by: string; source: string }

export interface DemoSnapshot {
  now: number;
  readings: Record<string, Reading>;
  actuators: Record<string, ActuatorState>;
  stage: string;
  alertsVersion: number;
  energy: EnergyView;
}

const MAX_MANUAL_S = REGISTRY_META.control.manual_override_max_s;
const RESERVOIR_MIN = 15;
const DEMO_USER = 'demo@greenhouse.local';

export class DemoController {
  meta: GreenhouseMeta = REGISTRY_META;
  stage: string;
  thresholds: Record<string, Threshold[]> = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));

  private startMs = Date.now();
  private tickN = 0;
  private zone: Record<number, { temp: number; hum: number; soil: number }> = {
    1: { temp: 27, hum: 72, soil: 66 },
    2: { temp: 27.4, hum: 70, soil: 63 },
  };
  private co2 = 520;
  private ph = 6.05;
  private levelPct = 82;
  private waterTemp = 26;
  private hopperG = 900;
  private offsets: Record<string, number> = {};
  private acts: Record<string, ActInternal> = {};
  private irr = { on: false, circuit: null as string | null, byAuto: false, sinceMs: 0 };
  private dose: Dose | null = null;
  private pumpSecondsToday = 0;

  readings: Record<string, Reading> = {};
  alerts: AlertItem[] = [];
  alertsVersion = 0;
  private alertSeq = 1;
  private openCond = new Map<string, number>();
  events: EventEntry[] = [];
  audit: AuditEntry[] = [];
  doses: DoseItem[] = [];
  users: UserItem[];
  calibrations: Record<string, { constants: Record<string, unknown>; at: string; by: string }> = {};
  private seq = 1;
  private energy = { solar: 320, loads: 185, battery: 78, today: 3.2, solarH: [] as number[], batteryH: [] as number[] };
  private acks = new Map<string, Ack>();

  constructor(stage: string) {
    this.stage = this.meta.stages.some(s => s.id === stage) ? stage : 'growth';
    for (const s of this.meta.sensors) this.offsets[s.id] = noise(0.6);
    for (const a of this.meta.actuators) {
      this.acts[a.id] = {
        actuator_id: a.id, on: false, mode: 'AUTO', installed: a.installed, manualUntilMs: null,
        lockout: a.installed ? null : 'NOT_INSTALLED', since: null, reason: null, ts: iso(this.startMs),
        ...(a.virtual ? { circuit: null, stage_circuit: this.stageCircuit() } : {}),
      };
    }
    const now = Date.now();
    this.users = [
      { id: 1, email: 'admin@greenhouse.local', name: 'Demo Administrator', role: 'admin', active: true, last_login_at: iso(now), created_at: iso(now - 30 * 864e5) },
      { id: 2, email: 'magso.staff@greenhouse.local', name: 'MAgSO Staff', role: 'viewer', active: true, last_login_at: iso(now - 2 * 864e5), created_at: iso(now - 20 * 864e5) },
    ];
    for (const s of this.meta.sensors) {
      if (s.calibration !== 'none' && s.installed) {
        this.calibrations[s.id] = { constants: { note: 'demo constants' }, at: iso(now - (s.type === 'ph' ? 12 : 3) * 864e5), by: 'admin@greenhouse.local' };
      }
    }
    this.raise('NODE_OFFLINE', 'high', 'node_b', 'Node B stopped reporting for 2 minutes (demo history).', now - 26 * 36e5, now - 26 * 36e5 + 12e4, true);
    this.raise('SENSOR_UNCALIBRATED', 'low', 'ph_01', 'pH probe calibration is 12 days old — recalibrate every 14 days.', now - 5 * 36e5, null, false);
    for (let d = 5; d >= 1; d--) {
      this.doses.push({ id: this.seq++, target_g: 20, delivered_g: round(20 + noise(0.8), 1), status: 'complete', reason: '', source: 'manual',
        issued_by: 'admin@greenhouse.local', started_at: iso(now - d * 864e5), finished_at: iso(now - d * 864e5 + 40e3), error_g: null });
    }
    this.doses.forEach(d => { d.error_g = d.delivered_g !== null ? round(d.delivered_g - d.target_g, 1) : null; });
    this.tick(0);
  }

  stageCircuit(): string {
    return this.meta.stages.find(s => s.id === this.stage)?.irrigation_mode ?? 'drip';
  }

  private band(p: string) {
    return this.thresholds[this.stage]?.find(t => t.parameter === p);
  }

  // ── physics + control ────────────────────────────────────────────────
  tick(dtS = 2): DemoSnapshot {
    const now = Date.now();
    this.tickN += 1;
    const sun = sunFactor(now);
    const valveFog = this.acts.valve_fog?.on;
    const irrigating = this.irr.on && this.acts.pump?.on;

    for (const z of [1, 2]) {
      const e = this.zone[z];
      const target = 23.5 + 7.5 * sun + (z === 2 ? 0.4 : 0);
      e.temp = clamp(e.temp + (target - e.temp) * 0.03 + noise(0.08), 15, 42);
      const humTarget = 88 - 1.6 * (e.temp - 22) + (valveFog ? 10 : 0);
      e.hum = clamp(e.hum + (humTarget - e.hum) * 0.04 + noise(0.3), 30, 99);
      const dry = 0.05 + 0.04 * sun;
      e.soil = clamp(e.soil - dry * (dtS / 2) + (irrigating ? 0.55 * (dtS / 2) : 0) + noise(0.05), 20, 95);
    }
    this.co2 = clamp(this.co2 + ((560 - 180 * sun) - this.co2) * 0.05 + noise(6), 380, 1600);
    this.ph = clamp(this.ph + (6.05 - this.ph) * 0.01 + noise(0.01), 4.5, 8);
    this.waterTemp = clamp(this.waterTemp + ((24 + 3 * sun) - this.waterTemp) * 0.01 + noise(0.03), 18, 34);
    if (irrigating) { this.levelPct -= 0.035 * (dtS / 2); this.pumpSecondsToday += dtS; }
    if (this.levelPct < 12) {
      this.levelPct = 88;
      this.event('reservoir', 'REFILL', 'Reservoir refilled (demo)', 'manual', null);
    }

    // Dosing: the auger delivers ~4 g per tick.
    if (this.dose) {
      const step = Math.min(4 + noise(0.4), this.dose.target - this.dose.delivered + 0.3);
      this.dose.delivered += Math.max(0, step);
      this.hopperG = Math.max(0, this.hopperG - Math.max(0, step));
      if (this.dose.delivered >= this.dose.target - 0.2) this.finishDose('complete');
    }

    // Energy (only shown when the greenhouse has the energy capability)
    const en = this.energy;
    en.solar = Math.round(clamp(en.solar + (650 * sun - en.solar) * 0.1 + noise(10), 0, 850));
    en.loads = Math.round(clamp(150 + (this.acts.lights?.on ? 60 : 0) + (this.acts.pump?.on ? 90 : 0) + noise(6), 80, 420));
    en.battery = round(clamp(en.battery + (en.solar - en.loads) / 50000, 10, 100), 1);
    en.today = round(en.today + en.solar / 3_600_000 * dtS, 2);
    en.solarH = [...en.solarH, en.solar].slice(-30);
    en.batteryH = [...en.batteryH, en.battery].slice(-30);

    this.sampleSensors(now, sun);
    this.control(now);
    this.checkAlerts(now);
    return this.snapshot(now);
  }

  private sampleSensors(now: number, sun: number) {
    const warming = now - this.startMs < 20_000;
    for (const s of this.meta.sensors) {
      if (!s.installed) continue;
      const off = this.offsets[s.id] ?? 0;
      let v: number | null = null;
      const z = this.zone[s.zone];
      switch (s.type) {
        case 'temperature': v = round(z.temp + off * 0.5 + noise(0.05), 2); break;
        case 'humidity': v = round(clamp(z.hum + off * 1.5 + noise(0.2), 0, 100), 2); break;
        case 'soil_moisture': v = round(clamp(z.soil + off * 2 + noise(0.2), 0, 100), 2); break;
        case 'light': v = round(Math.max(0, 32000 * sun * (s.zone === 2 ? 0.85 : 1) + (this.acts.lights?.on ? 3500 : 0) + noise(150)), 1); break;
        case 'co2': v = round(this.co2, 1); break;
        case 'ph': v = round(this.ph + noise(0.01), 3); break;
        case 'water_level': v = round(this.levelPct, 1); break;
        case 'water_temperature': v = round(this.waterTemp, 2); break;
        case 'hopper_weight': v = round(this.hopperG + noise(0.3), 1); break;
        case 'float_switch': v = this.levelPct > 12 ? 1 : 0; break;
        default: v = null;
      }
      const quality = s.type === 'co2' && warming ? 'WARMING' : 'VALID';
      this.readings[s.id] = { sensor_id: s.id, zone_id: s.zone, type: s.type, value: v, unit: s.unit, raw: v, quality, ts: iso(now) };
    }
  }

  private meanOf(type: string): number | null {
    const vals = Object.values(this.readings).filter(r => r.type === type && r.quality === 'VALID' && r.value !== null).map(r => r.value as number);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  private setAct(id: string, on: boolean, reason: string, source: string, now: number) {
    const a = this.acts[id];
    if (!a || a.on === on) return;
    a.on = on; a.since = iso(now); a.reason = reason; a.ts = iso(now);
    this.event(id, on ? 'ON' : 'OFF', reason, source, null);
  }

  private control(now: number) {
    const low = this.levelPct < RESERVOIR_MIN;
    // Manual overrides expire back to AUTO.
    for (const a of Object.values(this.acts)) {
      if (a.mode === 'MANUAL' && a.manualUntilMs !== null && now >= a.manualUntilMs) {
        a.mode = 'AUTO'; a.manualUntilMs = null; a.manual_until = null;
        this.event(a.actuator_id, 'MODE_AUTO', 'Manual override expired', 'auto', null);
        if (a.actuator_id === 'irrigation') this.applyIrrigation(false, this.stageCircuit(), 'manual override expired', 'auto', now);
        else if (a.actuator_id !== 'lights' && a.actuator_id !== 'auger') this.setAct(a.actuator_id, false, 'manual override expired', 'auto', now);
      }
    }

    // Irrigation (virtual): stage circuit, midpoint hysteresis.
    const irr = this.acts.irrigation;
    const soil = this.meanOf('soil_moisture');
    const b = this.band('soil_moisture');
    let want = this.irr.on;
    let reason = irr.reason ?? '';
    if (irr.mode === 'AUTO' && soil !== null && b) {
      const mid = (b.min + b.max) / 2;
      if (!this.irr.on && soil < b.min) { want = true; reason = `soil moisture ${soil.toFixed(1)}% < ${b.min}%`; this.irr.byAuto = true; }
      else if (this.irr.on && this.irr.byAuto && soil >= mid) { want = false; reason = `soil moisture reached ${mid}%`; }
    }
    if (low && want) { want = false; reason = 'LOW_WATER'; }
    irr.lockout = low ? 'LOW_WATER' : null;
    this.applyIrrigation(want, this.irr.circuit ?? this.stageCircuit(), reason, irr.mode === 'AUTO' ? 'auto' : 'manual', now);
    irr.stage_circuit = this.stageCircuit();

    // Grow lights: photoperiod and dim.
    const lights = this.acts.lights;
    if (lights && lights.mode === 'AUTO') {
      const h = hourOf(now);
      const pp = this.meta.control.photoperiod;
      const [sh, sm] = (pp?.start ?? '06:00').split(':').map(Number);
      const [eh, em] = (pp?.end ?? '18:00').split(':').map(Number);
      const inWindow = h >= sh + sm / 60 && h < eh + em / 60;
      const light = this.meanOf('light');
      const lb = this.band('light');
      const on = inWindow && light !== null && !!lb && light < lb.min + (lights.on ? lb.deadband : 0);
      this.setAct('lights', on, on ? `light ${Math.round(light ?? 0)} lux < ${lb?.min} lux` : inWindow ? 'enough daylight' : 'outside photoperiod', 'auto', now);
    }

    // Auger follows the dose.
    this.setAct('auger', !!this.dose, this.dose ? `dosing ${this.dose.target} g` : 'dose finished', this.dose?.source ?? 'auto', now);
    for (const id of ['pump', 'valve_fog', 'valve_drip', 'valve_sprinkler', 'servo_main']) {
      if (this.acts[id]) this.acts[id].lockout = low ? 'LOW_WATER' : null;
    }
  }

  private applyIrrigation(on: boolean, circuit: string, reason: string, source: string, now: number) {
    const irr = this.acts.irrigation;
    if (on === this.irr.on && (!on || circuit === this.irr.circuit)) return;
    if (on) {
      // valves before pump
      for (const c of ['fog', 'drip', 'sprinkler']) this.setAct(`valve_${c}`, c === circuit, reason, source, now);
      this.setAct('servo_main', true, reason, source, now);
      this.setAct('pump', true, reason, source, now);
      this.irr = { ...this.irr, on: true, circuit, sinceMs: now };
    } else {
      // pump off first
      this.setAct('pump', false, reason, source, now);
      for (const c of ['fog', 'drip', 'sprinkler']) this.setAct(`valve_${c}`, false, reason, source, now);
      this.setAct('servo_main', false, reason, source, now);
      this.irr = { ...this.irr, on: false, circuit: null, byAuto: false };
    }
    irr.on = this.irr.on; irr.circuit = this.irr.circuit; irr.reason = reason; irr.since = on ? iso(now) : irr.since; irr.ts = iso(now);
  }

  // ── alerts ───────────────────────────────────────────────────────────
  private raise(code: string, severity: AlertSeverity, source: string, message: string, at: number, resolvedAt: number | null, acked: boolean): AlertItem {
    const a: AlertItem = {
      id: this.alertSeq++, severity, source, code, message, raised_at: iso(at), last_seen_at: iso(at),
      resolved_at: resolvedAt ? iso(resolvedAt) : null,
      acknowledged_by: acked ? 'admin@greenhouse.local' : null, acknowledged_at: acked ? iso(at + 6e4) : null,
    };
    this.alerts = [a, ...this.alerts];
    this.alertsVersion++;
    return a;
  }

  private condition(key: string, active: boolean, make: () => { code: string; severity: AlertSeverity; source: string; message: string }, now: number) {
    const open = this.openCond.get(key);
    if (active && open === undefined) {
      const m = make();
      const a = this.raise(m.code, m.severity, m.source, m.message, now, null, false);
      this.openCond.set(key, a.id);
    } else if (!active && open !== undefined) {
      this.alerts = this.alerts.map(a => a.id === open ? { ...a, resolved_at: iso(now) } : a);
      this.openCond.delete(key);
      this.alertsVersion++;
    }
  }

  private checkAlerts(now: number) {
    this.condition('low_water', this.levelPct < RESERVOIR_MIN, () => ({ code: 'LOW_WATER', severity: 'critical', source: 'reservoir', message: `Reservoir at ${this.levelPct.toFixed(0)}% — below ${RESERVOIR_MIN}%.` }), now);
    for (const p of ['temperature', 'humidity', 'soil_moisture']) {
      const v = this.meanOf(p);
      const b = this.band(p);
      if (v === null || !b) continue;
      const margin = Math.max(b.deadband * 2, (b.max - b.min) * 0.15);
      const out = v < b.min - margin || v > b.max + margin;
      this.condition(`breach:${p}`, out, () => ({
        code: 'THRESHOLD_BREACH', severity: 'medium', source: p,
        message: `${p.replace('_', ' ')} at ${v.toFixed(1)} is outside the ${this.stage} band ${b.min}–${b.max}.`,
      }), now);
    }
  }

  // ── commands ─────────────────────────────────────────────────────────
  command(c: CommandRequest, by: string = DEMO_USER): Ack {
    const now = Date.now();
    const prior = this.acks.get(c.cmd_id);
    if (prior) return { ...prior, replayed: true };
    const done = (status: Ack['status'], reason: string | null, message: string): Ack => {
      const ack: Ack = { cmd_id: c.cmd_id, status, reason, message, ts: iso(now) };
      this.acks.set(c.cmd_id, ack);
      this.audit.unshift({ id: this.seq++, actor: by, action: `command_${status.toLowerCase()}`, target: `actuator:${c.actuator_id}`,
        detail: { cmd_id: c.cmd_id, action: c.action, duration_s: c.duration_s ?? null, target_g: c.target_g ?? null, circuit: c.circuit ?? null, reason, message }, occurred_at: iso(now) });
      return ack;
    };
    if (now - new Date(c.ts).getTime() > this.meta.control.command_expiry_s * 1000) return done('EXPIRED', 'EXPIRED', 'Command was older than 60 s.');

    if (c.action === 'ESTOP') {
      this.applyIrrigation(false, this.stageCircuit(), 'EMERGENCY STOP', 'safety', now);
      for (const a of Object.values(this.acts)) {
        if (!a.installed) continue;
        this.setAct(a.actuator_id, false, 'EMERGENCY STOP', 'safety', now);
        a.mode = 'MANUAL'; a.manualUntilMs = now + MAX_MANUAL_S * 1000; a.manual_until = iso(a.manualUntilMs);
      }
      if (this.dose) this.finishDose('aborted', 'ESTOP');
      this.raise('ESTOP', 'high', by, 'Emergency stop pressed — everything off and held in manual.', now, null, false);
      return done('SIMULATED', null, 'Emergency stop simulated — everything off. Tap AUTO on each device to resume.');
    }

    const def = this.meta.actuators.find(a => a.id === c.actuator_id);
    const a = this.acts[c.actuator_id];
    if (!def || !a) return done('REJECTED', 'UNKNOWN_ACTUATOR', 'Unknown device.');
    if (!def.installed) return done('REJECTED', 'NOT_INSTALLED', `${def.name} is not installed.`);

    if (c.action === 'AUTO') {
      a.mode = 'AUTO'; a.manualUntilMs = null; a.manual_until = null;
      if (def.id === 'irrigation') this.irr.byAuto = false;
      this.event(def.id, 'MODE_AUTO', 'Returned to automatic', 'manual', c.cmd_id);
      this.control(now);
      return done('SIMULATED', null, `${def.name} back on automatic (simulated).`);
    }

    if (c.action === 'DOSE') {
      if (def.id !== 'auger') return done('REJECTED', 'BAD_ACTION', 'Only the auger doses.');
      const g = c.target_g ?? 0;
      if (g <= 0) return done('REJECTED', 'BAD_TARGET', 'Enter a dose amount.');
      if (this.dose) return done('REJECTED', 'DOSING', 'A dose is already running.');
      if (g > this.hopperG - 10) return done('REJECTED', 'HOPPER_LOW', 'Not enough fertilizer in the hopper.');
      this.dose = { cmd_id: c.cmd_id, target: g, delivered: 0, startedMs: now, issued_by: by, source: 'manual' };
      this.control(now);
      return done('SIMULATED', null, `Dosing ${g} g (simulated).`);
    }

    // ON / OFF
    const on = c.action === 'ON';
    if (def.id === 'auger' && !on && this.dose) {
      this.finishDose('aborted', 'STOPPED');
      this.control(now);
      return done('SIMULATED', null, 'Dose stopped (simulated).');
    }
    if (on && def.water && this.levelPct < RESERVOIR_MIN) return done('REJECTED', 'LOW_WATER', 'Reservoir water is too low.');
    const dur = Math.min(c.duration_s ?? MAX_MANUAL_S, MAX_MANUAL_S);
    a.mode = 'MANUAL'; a.manualUntilMs = now + dur * 1000; a.manual_until = iso(a.manualUntilMs);
    this.event(def.id, 'MODE_MANUAL', `Manual for ${Math.round(dur / 60)} min`, 'manual', c.cmd_id);
    if (def.id === 'irrigation') {
      this.irr.byAuto = false;
      this.applyIrrigation(on, c.circuit ?? this.stageCircuit(), on ? `manual ${c.circuit ?? this.stageCircuit()}` : 'manual off', 'manual', now);
    } else {
      this.setAct(def.id, on, on ? 'manual on' : 'manual off', 'manual', now);
    }
    return done('SIMULATED', null, `${def.name} ${on ? 'on' : 'off'} for up to ${Math.round(dur / 60)} min (simulated).`);
  }

  private finishDose(status: 'complete' | 'aborted', reason = '') {
    const d = this.dose;
    if (!d) return;
    const now = Date.now();
    const delivered = round(d.delivered, 1);
    this.doses.unshift({ id: this.seq++, target_g: d.target, delivered_g: delivered, status, reason, source: d.source, issued_by: d.issued_by,
      started_at: iso(d.startedMs), finished_at: iso(now), error_g: round(delivered - d.target, 1) });
    this.dose = null;
  }

  private event(actuator_id: string, action: string, reason: string, source: string, cmd_id: string | null) {
    this.events.unshift({ id: this.seq++, actuator_id, action, reason, source, issued_by: source === 'manual' ? DEMO_USER : 'system',
      cmd_id, duration_s: null, detail: null, occurred_at: iso(Date.now()) });
    if (this.events.length > 300) this.events.length = 300;
  }

  setStage(id: string, by = DEMO_USER) {
    const prev = this.stage;
    this.stage = id;
    this.audit.unshift({ id: this.seq++, actor: by, action: 'stage_changed', target: 'greenhouse:stage', detail: { old: prev, new: id }, occurred_at: iso(Date.now()) });
  }

  putThresholds(stage: string, list: { parameter: string; min: number; max: number; deadband?: number }[], by = DEMO_USER): Threshold[] {
    const cur = this.thresholds[stage] ?? [];
    this.thresholds[stage] = cur.map(t => {
      const n = list.find(l => l.parameter === t.parameter);
      return n ? { ...t, min: n.min, max: n.max, deadband: n.deadband ?? t.deadband, version: (t.version ?? 1) + 1, updated_at: iso(Date.now()), updated_by: by } : t;
    });
    for (const c of list) {
      this.audit.unshift({ id: this.seq++, actor: by, action: 'threshold_updated', target: `threshold:${stage}:${c.parameter}`, detail: { ...c }, occurred_at: iso(Date.now()) });
    }
    return this.thresholds[stage];
  }

  ackAlert(id: number, by = DEMO_USER): AlertItem {
    let found: AlertItem | undefined;
    this.alerts = this.alerts.map(a => {
      if (a.id !== id) return a;
      const isEvent = ['ESTOP', 'DOSE_ABORTED', 'MAX_RUN_EXCEEDED'].includes(a.code);
      found = { ...a, acknowledged_by: by, acknowledged_at: iso(Date.now()), resolved_at: a.resolved_at ?? (isEvent ? iso(Date.now()) : null) };
      return found;
    });
    if (!found) throw new Error('Alert not found');
    this.audit.unshift({ id: this.seq++, actor: by, action: 'alert_acknowledged', target: `alert:${id}`, detail: { code: found.code }, occurred_at: iso(Date.now()) });
    this.alertsVersion++;
    return found;
  }

  snapshot(now = Date.now()): DemoSnapshot {
    const actuators: Record<string, ActuatorState> = {};
    for (const [id, a] of Object.entries(this.acts)) {
      const rest: Partial<ActInternal> = { ...a };
      delete rest.manualUntilMs;
      actuators[id] = rest as ActuatorState;
    }
    const en = this.energy;
    return {
      now, readings: { ...this.readings }, actuators, stage: this.stage, alertsVersion: this.alertsVersion,
      energy: { solarW: en.solar, loadsW: en.loads, batteryPct: en.battery, solarTodayKWh: en.today, solarHistory: en.solarH, batteryHistory: en.batteryH },
    };
  }

  // ── read-side (what the REST API would return) ──────────────────────
  history(q: HistoryQuery): HistoryResult {
    const to = q.to ? Date.parse(q.to) : Date.now();
    const from = q.from ? Date.parse(q.from) : to - 24 * 36e5;
    const res = q.resolution ?? '15m';
    const step = res === 'raw' ? 60e3 : res === '15m' ? 9e5 : res === '1h' ? 36e5 : 864e5;
    const ids = this.meta.sensors.filter(s => s.installed && (!q.sensor || s.id === q.sensor) && (!q.type || s.type === q.type) && (q.zone === undefined || s.zone === q.zone));
    const series: Record<string, HistoryPoint[]> = {};
    for (const s of ids) {
      const pts: HistoryPoint[] = [];
      for (let t = Math.ceil(from / step) * step; t <= to && pts.length < 2000; t += step) {
        const v = this.modelValue(s.type, s.zone, t, s.id);
        if (v === null) continue;
        pts.push({ ts: iso(t), value: round(v, 2), min: round(v - Math.abs(v) * 0.02, 2), max: round(v + Math.abs(v) * 0.02, 2), n: Math.round(step / 30e3) });
      }
      series[s.id] = pts;
    }
    return { from: iso(from), to: iso(to), resolution: res, series };
  }

  /** Plausible value of a sensor at a past time, for synthetic history. */
  private modelValue(type: string, zone: number, t: number, seed: string): number | null {
    const sun = sunFactor(t);
    const n = hashNoise(seed, t / 6e5);
    const day = Math.floor(t / 864e5);
    switch (type) {
      case 'temperature': return 23.5 + 7.5 * sun + (zone === 2 ? 0.4 : 0) + n * 0.8;
      case 'humidity': return clamp(88 - 1.6 * (6 * sun + 1.5) + n * 3, 30, 99);
      case 'soil_moisture': { const phase = ((t / 36e5) % 5) / 5; return 58 + 14 * (1 - phase) + n * 2; }
      case 'light': return Math.max(0, 32000 * sun * (zone === 2 ? 0.85 : 1) + n * 800);
      case 'co2': return 560 - 180 * sun + n * 30;
      case 'ph': return 6.05 + n * 0.15;
      case 'water_level': return 50 + 35 * (((t / 864e5) * 1.3) % 1 < 0.5 ? 1 - (((t / 864e5) * 1.3) % 1) : ((t / 864e5) * 1.3) % 1);
      case 'water_temperature': return 24 + 3 * sun + n * 0.3;
      case 'hopper_weight': return Math.max(100, 1000 - ((day % 30) * 20));
      case 'float_switch': return 1;
      default: return null;
    }
  }

  alertsList(status: 'all' | 'open' | 'unacknowledged' = 'all', limit = 100): AlertItem[] {
    return this.alerts
      .filter(a => status === 'all' || (status === 'open' ? !a.resolved_at : !a.acknowledged_at))
      .slice(0, limit);
  }

  waterUsage(days = 7): WaterDay[] {
    const out: WaterDay[] = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 864e5);
      const minutes = i === 0 ? this.pumpSecondsToday / 60 : 28 + hashNoise('water', d.getTime() / 864e5) * 12;
      out.push({ date: d.toISOString().slice(0, 10), litres: round(minutes * 4, 1), pump_minutes: round(minutes, 1), method: 'pump runtime × 4 L/min (demo)' });
    }
    return out;
  }

  fertilizer(days = 30): FertilizerReport {
    const since = Date.now() - days * 864e5;
    const doses = this.doses.filter(d => Date.parse(d.started_at) >= since);
    const complete = doses.filter(d => d.status === 'complete');
    const errs = complete.map(d => Math.abs(d.error_g ?? 0));
    return {
      doses, count: doses.length, complete: complete.length,
      total_delivered_g: round(doses.reduce((a, d) => a + (d.delivered_g ?? 0), 0), 1),
      mean_abs_error_g: errs.length ? round(errs.reduce((a, b) => a + b, 0) / errs.length, 2) : null,
    };
  }

  calibrationList(): CalibrationEntry[] {
    return this.meta.sensors.map(s => {
      const c = this.calibrations[s.id];
      return {
        sensor_id: s.id, type: s.type, zone: s.zone, kind: s.calibration, installed: s.installed,
        calibrated_at: c?.at ?? null, performed_by: c?.by ?? null,
        days_since: c ? Math.floor((Date.now() - Date.parse(c.at)) / 864e5) : null,
        constants: c?.constants ?? null, latest_raw: this.readings[s.id]?.raw ?? null,
      };
    });
  }

  calibrate(sensorId: string, body: CalibrationBody, by = DEMO_USER) {
    const constants: Record<string, unknown> = { ...body, simulated: true };
    this.calibrations[sensorId] = { constants, at: iso(Date.now()), by };
    this.audit.unshift({ id: this.seq++, actor: by, action: 'sensor_calibrated', target: `sensor:${sensorId}`, detail: constants, occurred_at: iso(Date.now()) });
    this.alerts = this.alerts.map(a => a.source === sensorId && a.code === 'SENSOR_UNCALIBRATED' && !a.resolved_at ? { ...a, resolved_at: iso(Date.now()) } : a);
    this.alertsVersion++;
    return { constants };
  }

  addUser(u: { email: string; name: string; role: 'admin' | 'viewer' }): UserItem {
    if (this.users.some(x => x.email === u.email)) throw new Error('That email is already registered.');
    const item: UserItem = { id: this.users.length + 1, email: u.email, name: u.name, role: u.role, active: true, last_login_at: null, created_at: iso(Date.now()) };
    this.users = [...this.users, item];
    return item;
  }

  patchUser(id: number, patch: Partial<{ name: string; role: 'admin' | 'viewer'; active: boolean }>): UserItem {
    let out: UserItem | undefined;
    this.users = this.users.map(u => (u.id === id ? (out = { ...u, ...patch }) : u));
    if (!out) throw new Error('User not found');
    return out;
  }
}
