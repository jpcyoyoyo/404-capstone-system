// The data-provider contract (Integration Plan §9.3, "simulation as a provider, not a source").
// Two implementations satisfy it: LiveProvider (controller REST + MQTT over WebSocket) and
// DemoProvider (an in-app simulation of the same controller). Pages consume it through
// useGreenhouse() and only look at `mode`/`link` to label what they show.
import type {
  Ack, ActuatorState, AlertItem, AuditEntry, CalibrationBody, CalibrationEntry, CommandRequest, EventEntry,
  FertilizerReport, GreenhouseMeta, HistoryResult, Reading, Threshold, UserItem, WaterDay, ZoneSummary,
} from '../contract/types';

export type Link = 'local' | 'remote' | 'demo' | 'offline';

export type MetricKey =
  | 'temperature' | 'humidity' | 'soil_moisture' | 'light' | 'co2' | 'ph' | 'ec'
  | 'water_level' | 'water_temperature' | 'water_flow' | 'hopper_weight';

export type MetricStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface MetricView {
  key: MetricKey;
  label: string;
  unit: string;
  /** Greenhouse value used by the control loop (mean of zone medians); null when no valid reading. */
  value: number | null;
  status: MetricStatus;
  /** Why status is 'unknown' or degraded, e.g. "Warming up", "Not installed", "No valid reading". */
  note: string | null;
  installed: boolean;
  zones: Record<string, { median: number | null; valid: number; total: number }>;
  manualRequired: number[];
  band: { min: number; max: number; deadband: number } | null;
  /** Recent values for sparklines (oldest first), one per update. */
  history: number[];
}

export interface EnergyView {
  solarW: number; loadsW: number; batteryPct: number; solarTodayKWh: number;
  solarHistory: number[]; batteryHistory: number[];
}

export type CommandInput = Omit<CommandRequest, 'cmd_id' | 'ts'> & { cmd_id?: string };

export interface HistoryQuery { sensor?: string; type?: string; zone?: number; from?: string; to?: string; resolution?: 'raw' | '15m' | '1h' | '1d' }

/** Everything that is fetched on demand rather than streamed. Mirrors the REST API. */
export interface DataService {
  history(q: HistoryQuery): Promise<HistoryResult>;
  thresholds(stage: string): Promise<Threshold[]>;
  putThresholds(stage: string, list: { parameter: string; min: number; max: number; deadband?: number }[]): Promise<Threshold[]>;
  alerts(status?: 'all' | 'open' | 'unacknowledged', limit?: number): Promise<AlertItem[]>;
  ackAlert(id: number): Promise<AlertItem>;
  audit(limit?: number): Promise<AuditEntry[]>;
  events(limit?: number, actuator?: string): Promise<EventEntry[]>;
  waterUsage(days?: number): Promise<WaterDay[]>;
  fertilizer(days?: number): Promise<FertilizerReport>;
  calibrations(): Promise<CalibrationEntry[]>;
  calibrate(sensorId: string, body: CalibrationBody): Promise<{ constants: Record<string, unknown> }>;
  users(): Promise<UserItem[]>;
  addUser(u: { email: string; name: string; password: string; role: 'admin' | 'viewer' }): Promise<UserItem>;
  patchUser(id: number, patch: Partial<{ name: string; role: 'admin' | 'viewer'; active: boolean; password: string }>): Promise<UserItem>;
}

export interface GreenhouseData {
  mode: 'live' | 'demo';
  link: Link;
  /** True once the first snapshot has arrived (live) — pages show a skeleton until then. */
  ready: boolean;
  /** Last connection/load problem, for a banner. */
  error: string | null;
  /** True when live updates arrive over MQTT; false when falling back to REST polling. */
  streaming: boolean;
  lastUpdate: string | null;
  controllerOnline: boolean;
  nodes: Record<string, boolean>;

  meta: GreenhouseMeta;
  readings: Record<string, Reading>;
  zones: Record<string, ZoneSummary>;
  metrics: Record<MetricKey, MetricView>;
  actuators: Record<string, ActuatorState>;

  activeStageId: string;
  /** Thresholds for the active stage, keyed by parameter. */
  thresholds: Record<string, Threshold>;
  openAlerts: AlertItem[];
  unackedCount: number;
  /** Solar/battery telemetry; null unless the greenhouse has the energy capability. */
  energy: EnergyView | null;
  /** Commands are allowed on this path (false on the cloud path while remote_commands is off). */
  canCommand: boolean;

  sendCommand(c: CommandInput): Promise<Ack>;
  setActiveStage(stageId: string): Promise<void>;
  refresh(): Promise<void>;
  /** Ask the provider to reload alerts after a change made elsewhere. */
  reloadAlerts(): Promise<void>;
  data: DataService;
}
