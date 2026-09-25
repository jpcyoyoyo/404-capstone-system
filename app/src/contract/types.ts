// Mirrors contract/schemas/*.schema.json and the REST API in controller/greenhouse/services/api.py.
// Change the contract first, then these types.

export type Quality = 'VALID' | 'WARMING' | 'STALE' | 'INVALID' | 'UNCALIBRATED';

export type SensorType =
  | 'temperature' | 'humidity' | 'soil_moisture' | 'light' | 'co2' | 'ph' | 'ec'
  | 'water_temperature' | 'water_level' | 'water_flow' | 'hopper_weight' | 'float_switch';

export interface Reading {
  sensor_id: string;
  zone_id: number;
  type: SensorType | string;
  value: number | null;
  unit: string;
  raw: number | null;
  quality: Quality;
  ts: string;
  last_value?: number | null;
}

export type ActuatorMode = 'AUTO' | 'MANUAL';

export interface ActuatorState {
  actuator_id: string;
  on: boolean;
  mode: ActuatorMode;
  installed?: boolean;
  lockout?: string | null;
  manual_until?: string | null;
  since?: string | null;
  reason?: string | null;
  circuit?: string | null;
  stage_circuit?: string | null;
  ts?: string | null;
}

export type CommandAction = 'ON' | 'OFF' | 'AUTO' | 'DOSE' | 'ESTOP';
export type Circuit = 'fog' | 'drip' | 'sprinkler';

export interface CommandRequest {
  cmd_id: string;
  actuator_id: string;          // 'all' for ESTOP
  action: CommandAction;
  duration_s?: number;
  target_g?: number;
  circuit?: Circuit;
  reason?: string;
  ts: string;
}

export type AckStatus = 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'SIMULATED';

export interface Ack {
  cmd_id: string;
  status: AckStatus;
  reason?: string | null;
  message?: string | null;
  ts: string;
  replayed?: boolean;
}

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertItem {
  id: number;
  severity: AlertSeverity;
  source: string;
  code: string;
  message: string;
  raised_at: string;
  resolved_at: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  last_seen_at?: string | null;
}

export interface Threshold {
  parameter: string;
  min: number;
  max: number;
  deadband: number;
  unit: string;
  version?: number;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface StageDef {
  id: string;
  name: string;
  sequence: number;
  irrigation_mode: Circuit | string;
  description: string;
}

export interface SensorDef {
  id: string;
  type: string;
  zone: number;
  host: string;
  unit: string;
  installed: boolean;
  calibration: string;
  calibrated_at?: string | null;
}

export interface ActuatorDef {
  id: string;
  name: string;
  group: string;
  kind: string;
  installed: boolean;
  water: boolean;
  manual_only: boolean;
  virtual: boolean;
  circuit: string | null;
}

export interface GreenhouseMeta {
  id: string;
  name: string;
  timezone: string;
  role?: 'controller' | 'cloud';
  capabilities: { energy?: boolean; push?: boolean; remote_commands?: boolean };
  network_mode?: string;
  active_stage?: string;
  stages: StageDef[];
  zones: { id: number; name: string; description: string }[];
  nodes: { id: string; board: string; zone: number }[];
  sensors: SensorDef[];
  actuators: ActuatorDef[];
  control: { cycle_s: number; command_expiry_s: number; manual_override_max_s: number; photoperiod?: { start: string; end: string } | null };
  server_time?: string;
}

export interface ZoneSummary {
  value: number | null;
  manual_required: number[];
  zones: Record<string, { median: number | null; valid: number; total: number }>;
}

export interface LiveSnapshot {
  greenhouse_id: string;
  server_time: string;
  active_stage: string;
  controller: { online: boolean; ts: string | null; network_mode?: string; nodes?: Record<string, boolean> };
  readings: Record<string, Reading>;
  zones: Record<string, ZoneSummary>;
  actuators: Record<string, ActuatorState>;
  alerts_open: number;
}

export interface HistoryPoint { ts: string; value: number | null; min?: number; max?: number; n?: number; quality?: string }
export interface HistoryResult { from: string; to: string; resolution: string; series: Record<string, HistoryPoint[]> }

export interface AuditEntry { id: number; actor: string; action: string; target: string; detail: Record<string, unknown> | null; occurred_at: string }
export interface EventEntry {
  id: number; actuator_id: string; action: string; reason: string; source: string; issued_by: string;
  cmd_id: string | null; duration_s: number | null; detail: Record<string, unknown> | null; occurred_at: string;
}

export interface UserItem { id: number; email: string; name: string; role: 'admin' | 'viewer'; active: boolean; last_login_at: string | null; created_at: string | null }

export interface CalibrationEntry {
  sensor_id: string; type: string; zone: number; kind: string; installed: boolean;
  calibrated_at: string | null; performed_by: string | null; days_since: number | null;
  constants: Record<string, unknown> | null; latest_raw: number | null;
}

export interface CalibrationBody {
  kind: 'dry_wet' | 'two_point' | 'scale' | 'raw';
  dry?: number; wet?: number;
  points?: { raw: number; ref: number }[];
  offset?: number; scale?: number; known_g?: number; raw_at_known?: number;
  constants?: Record<string, unknown>;
  note?: string;
}

export interface DoseItem {
  id: number; target_g: number; delivered_g: number | null; status: string; reason: string; source: string;
  issued_by: string; started_at: string; finished_at: string | null; error_g: number | null;
}
export interface FertilizerReport { doses: DoseItem[]; count: number; complete: number; total_delivered_g: number; mean_abs_error_g: number | null }
export interface WaterDay { date: string; litres: number; pump_minutes: number; method: string }

export interface MqttInfo { url: string; username: string | null; password: string | null; prefix: string }

export interface SessionUser { id: string; email: string; name: string; role: 'admin' | 'viewer' | 'kiosk' }

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  user?: { id: number; email: string; name: string; role: 'admin' | 'viewer' };
  mqtt: MqttInfo | null;
}
