// Human wording for the machine codes the controller sends (alert codes, ack reasons, lockouts).
import type { AlertSeverity } from './types';

export const REASON_TEXT: Record<string, string> = {
  LOW_WATER: 'Reservoir water is too low — pump and valves are locked out.',
  FLOAT_SWITCH_FAULT: 'Float switch disagrees with the level sensor — pump locked out until checked.',
  NOT_INSTALLED: 'This device is not installed yet.',
  MIN_OFF_TIME: 'It was switched off moments ago; wait for the minimum off time.',
  MIN_ON_TIME: 'It was switched on moments ago; wait for the minimum on time.',
  COOLDOWN: 'Cooling down after a long run.',
  DAILY_CAP: 'Daily run-time limit reached.',
  MAX_RUN_EXCEEDED: 'Stopped after the maximum continuous run time.',
  PUMP_BUSY: 'The pump is busy with another circuit.',
  NO_OPEN_VALVE: 'No valve is open, so the pump cannot start.',
  DOSING: 'A fertilizer dose is already running.',
  FERTIGATION_GATED: 'Held while fertigation runs.',
  BAD_ACTION: 'That action is not valid for this device.',
  BAD_TARGET: 'Enter a dose amount.',
  UNKNOWN_ACTUATOR: 'Unknown device.',
  UNKNOWN_CIRCUIT: 'Unknown irrigation circuit.',
  REMOTE_READ_ONLY: 'Controls work only on the greenhouse network for now.',
  EXPIRED: 'The controller did not confirm in time; nothing was changed.',
  HOPPER_LOW: 'Not enough fertilizer in the hopper for that dose.',
  MANUAL_ONLY: 'This device is moved by hand only.',
};

export function reasonText(code: string | null | undefined, fallback?: string | null): string {
  if (!code) return fallback ?? '';
  return REASON_TEXT[code] ?? fallback ?? code.replace(/_/g, ' ').toLowerCase();
}

export const ALERT_TITLE: Record<string, string> = {
  LOW_WATER: 'Reservoir low',
  FLOAT_SWITCH_FAULT: 'Float switch fault',
  NODE_OFFLINE: 'Sensing node offline',
  SENSOR_INVALID: 'Sensor giving bad readings',
  SENSOR_STALE: 'Sensor not reporting',
  SENSOR_UNCALIBRATED: 'Sensor needs calibration',
  ZONE_MANUAL_REQUIRED: 'Zone needs manual control',
  MAX_RUN_EXCEEDED: 'Run-time limit hit',
  THRESHOLD_BREACH: 'Out of range',
  ESTOP: 'Emergency stop',
  CONTROLLER_OFFLINE: 'Controller offline',
  DOSE_ABORTED: 'Fertilizer dose stopped',
  HAL_ERROR: 'Hardware error',
};

export function alertTitle(code: string): string {
  if (ALERT_TITLE[code]) return ALERT_TITLE[code];
  if (code.startsWith('DOSE')) return 'Fertilizer dose problem';
  return code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

export function severityPill(s: AlertSeverity): 'crit' | 'warn' | 'info' | 'idle' {
  return s === 'critical' || s === 'high' ? 'crit' : s === 'medium' ? 'warn' : 'info';
}

export const SUGGESTED_ACTIONS: Record<string, string[]> = {
  LOW_WATER: ['Refill the reservoir', 'Check for leaks at the pump and valves', 'Irrigation resumes on its own once the level recovers'],
  FLOAT_SWITCH_FAULT: ['Check the float switch moves freely', 'Compare with the ultrasonic level reading', 'Inspect the float switch wiring (GPIO19)'],
  NODE_OFFLINE: ['Check the node has power', 'Check the node is within Wi-Fi range', 'Readings from that zone are held until it returns'],
  SENSOR_INVALID: ['Inspect the probe and its cable', 'Recalibrate if the probe was moved or cleaned'],
  SENSOR_STALE: ['Check the node and its wiring', 'Restart the node if it stays silent'],
  SENSOR_UNCALIBRATED: ['Open Calibration and record constants for this sensor'],
  ZONE_MANUAL_REQUIRED: ['Too few valid sensors in this zone — watch it by eye', 'Use Controls to irrigate manually if needed', 'Fix or replace the failed sensors'],
  MAX_RUN_EXCEEDED: ['Check for a blocked line or a stuck sensor', 'Automatic control resumes after the cooldown'],
};
