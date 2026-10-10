// Human wording for the machine codes the controller sends (alert codes, ack reasons, lockouts).
import type { AlertSeverity } from './types';

export const REASON_TEXT: Record<string, string> = {
  LOW_WATER: 'The reservoir water is too low, so the pump and valves are locked. Refill the reservoir; the lock clears by itself.',
  FLOAT_SWITCH_FAULT: 'The float switch gives no reading, so the pump is locked off to be safe. Check the float switch and its wire (GPIO19).',
  NOT_INSTALLED: 'This device is not installed yet.',
  MIN_OFF_TIME: 'It was switched off moments ago and has to stay off a little longer to protect it.',
  MIN_ON_TIME: 'It was switched on moments ago and has to stay on a little longer to protect it.',
  COOLDOWN: 'It is cooling down after a long run.',
  DAILY_CAP: 'It has reached its run-time limit for today; it can run again after midnight.',
  MAX_RUN_EXCEEDED: 'It ran for its maximum time and was stopped.',
  PUMP_BUSY: 'Another irrigation circuit is running; only one circuit runs at a time.',
  NO_OPEN_VALVE: 'No irrigation valve is open. Use Water now, which opens a valve before starting the pump.',
  DOSING: 'A fertilizer dose is already running.',
  FERTIGATION_GATED: 'Fertilizer is held back because the soil is already wet or the EC is already high.',
  BAD_ACTION: 'That action does not apply to this device.',
  BAD_TARGET: 'The dose must be more than 0 g and at most 200 g.',
  UNKNOWN_ACTUATOR: 'The controller does not know this device.',
  UNKNOWN_CIRCUIT: 'There is no valve for that irrigation circuit.',
  REMOTE_READ_ONLY: 'Devices can only be controlled on the greenhouse network for now.',
  EXPIRED: 'The command reached the controller too late, so nothing was changed. Try again.',
  CONTROLLER_TIMEOUT: 'The control service did not answer, so nothing was changed. Check it is running (journalctl -u greenhouse-control).',
  ACTUATOR_FAULT: 'The controller could not drive this device\'s output. Check the relay board\'s 5 V supply and the device\'s wire.',
  STOCK_LOW: 'There is not enough stock solution in the bottle for that dose. Mix a new batch.',
  NO_FLOW: 'The dosing pump ran but the bottle did not get lighter — empty bottle, kinked tube or air in the line.',
  LOAD_CELL_FAULT: 'The load cell under the stock bottle is not giving a reading, so a dose cannot be weighed. Check the HX711 wires (DT, SCK, VCC, GND).',
  PUMP_ERROR: 'The controller could not drive the dosing pump; the controller log has the details.',
  TIMEOUT: 'The dose took longer than the time limit and was stopped.',
  NO_DOSER: 'The dosing pump is not available on this controller.',
  MANUAL_ONLY: 'This valve is turned by hand.',
};

/** Short words for a lockout, for pills and narrow tiles. */
export const LOCK_SHORT: Record<string, string> = {
  LOW_WATER: 'Low water — refill the reservoir',
  FLOAT_SWITCH_FAULT: 'Float switch not reading — check GPIO19',
  NOT_INSTALLED: 'Not installed',
  DOSING: 'Dosing',
  MANUAL_ONLY: 'Turned by hand',
};
export const LOCK_PILL: Record<string, string> = {
  LOW_WATER: 'LOW WATER', FLOAT_SWITCH_FAULT: 'FLOAT FAULT', NOT_INSTALLED: 'N/A', DOSING: 'DOSING',
};

export function reasonText(code: string | null | undefined, fallback?: string | null): string {
  if (!code) return fallback ?? '';
  return REASON_TEXT[code] ?? fallback ?? code.replace(/_/g, ' ').toLowerCase();
}

/** '45 s', '2 min 5 s', '5 min' — same as wait_text in controller/greenhouse/messages.py. */
export function waitText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

const VERB: Record<string, string> = {
  ON: 'not switched on', OFF: 'not switched off', AUTO: 'not returned to automatic', DOSE: 'dose not started', ESTOP: 'emergency stop not done',
};

/** A refused or unconfirmed command in plain words: a title naming the device and what did not happen,
 *  then why and when to try again. Works with the controller's sentence ("Grow lights: not switched on —
 *  it was switched off moments ago …. Try again in 4 min 10 s.") and with older or demo messages. */
export function commandRefusal(reason: string | null | undefined, message: string | null | undefined,
  deviceName: string, action: string): { title: string; text: string } {
  const title = `${deviceName}: ${VERB[action] ?? 'not done'}`;
  const m = (message ?? '').match(/^.+?: not [^—]+ — (.+)$/) ?? (message ?? '').match(/^.+?: (?:dose|emergency stop) not [^—]+ — (.+)$/);
  if (m) return { title, text: m[1].replace(/^\w/, c => c.toUpperCase()) };
  let text = reason ? reasonText(reason) : (message || 'The controller refused the command.');
  if (!/[.!?]$/.test(text)) text += '.';
  const secs = (message ?? '').match(/(?:in|again in) (\d+) s\b/);
  if (secs) text += ` Try again in ${waitText(Number(secs[1]))}.`;
  return { title, text };
}

/** What an error thrown while sending a command means for the user. */
export function commandError(status: number | undefined, message: string): string {
  if (status === 403) return 'Only an administrator can control devices. Nothing was changed.';
  if (status === 404) return 'The controller does not know this device. Nothing was changed.';
  if (status === 401) return 'Your sign-in has run out. Sign in again; nothing was changed.';
  if (!status) return `${message.replace(/\.$/, '')}. Nothing was changed — check you are on the greenhouse network.`;
  return `${message.replace(/\.$/, '')}. Nothing was changed.`;
}

const CODE_WORDS: Record<string, string> = {
  LOW_WATER: 'reservoir too low', FLOAT_SWITCH_FAULT: 'float switch not reading', NOT_INSTALLED: 'not installed',
  MIN_OFF_TIME: 'minimum off time', MIN_ON_TIME: 'minimum on time', COOLDOWN: 'cooling down after a long run',
  DAILY_CAP: 'run-time limit for today reached', MAX_RUN_EXCEEDED: 'maximum run time reached', PUMP_BUSY: 'another circuit is running',
  NO_OPEN_VALVE: 'no valve open', DOSING: 'a dose is running', FERTIGATION_GATED: 'fertilizer held back (soil wet or EC high)',
  MANUAL_OVERRIDE: 'manual command', ESTOP: 'emergency stop', EXPIRED: 'command arrived too late',
  CONTROLLER_TIMEOUT: 'control service did not answer', ACTUATOR_FAULT: 'output failed',
};

/** Activity-log text with any leftover machine codes turned into words. Lines written before
 *  11 Oct 2026 read "ON deferred: MIN_OFF_TIME (23 s)" or "pump interlock: LOW_WATER". */
export function plainDetail(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/^(ON|OFF) deferred: ([A-Z_]+)(?: \((\d+) s\))?$/, (_m, dir: string, c: string, s?: string) =>
      `waiting to switch ${dir.toLowerCase()}: ${CODE_WORDS[c] ?? c.replace(/_/g, ' ').toLowerCase()}${s ? `, ${waitText(Number(s))} left` : ''}`)
    .replace(/\b[A-Z][A-Z]+(?:_[A-Z]+)+\b/g, c => CODE_WORDS[c] ?? (REASON_TEXT[c] ? c.replace(/_/g, ' ').toLowerCase() : c));
}

const EVENT_ACTION: Record<string, string> = {
  ON: 'switched on', OFF: 'switched off', SUPPRESSED: 'held back', DEFERRED: 'waiting',
  MODE_AUTO: 'back to automatic', MODE_MANUAL: 'manual', CMD_ON: 'command: on', CMD_OFF: 'command: off',
  CMD_AUTO: 'command: automatic', CMD_DOSE: 'command: dose', CMD_ESTOP: 'emergency stop',
};

/** "CMD_ON" → "command: on", "SUPPRESSED" → "held back". */
export function eventAction(action: string): string {
  return EVENT_ACTION[action] ?? action.replace(/^CMD_/, 'command: ').replace(/_/g, ' ').toLowerCase();
}

/** How a fertilizer dose ended early: a short title for lists and one plain sentence.
 *  Same wording as STOP_TEXT in controller/greenhouse/fertigation.py. */
export const DOSE_STOP: Record<string, { title: string; text: string }> = {
  LOAD_CELL_FAULT: { title: 'Load cell not reading', text: 'The scale under the stock bottle gave no weight, so the pump was stopped. Check the HX711 wires (DT, SCK, VCC, GND).' },
  NO_FLOW: { title: 'No solution moved', text: 'The pump ran but the bottle did not get lighter — empty bottle, kinked tube or air in the line.' },
  TIMEOUT: { title: 'Time limit reached', text: 'The dose took longer than the time limit and was stopped.' },
  INTERLOCK: { title: 'Safety lock', text: 'A safety lock came on during the dose (low reservoir, float switch or emergency stop).' },
  STOPPED: { title: 'Stopped by hand', text: 'Stop dose was pressed.' },
  ESTOP: { title: 'Emergency stop', text: 'The emergency stop ended the dose.' },
  NO_DOSER: { title: 'Pump not available', text: 'The dosing pump is not set up on this controller.' },
  PUMP_ERROR: { title: 'Pump driver error', text: 'The controller could not drive the pump; the controller log has the details.' },
};

export function doseStop(reason: string | null | undefined): { title: string; text: string } {
  if (reason && DOSE_STOP[reason]) return DOSE_STOP[reason];
  if (reason?.startsWith('ERROR')) return DOSE_STOP.PUMP_ERROR;   // doses recorded before 11 Oct 2026
  const words = (reason || 'stopped').replace(/_/g, ' ').toLowerCase();
  return { title: words.replace(/^\w/, c => c.toUpperCase()), text: 'The dose ended before reaching its target.' };
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
  LOAD_CELL_FAULT: 'Dose stopped — load cell not reading',
  NO_FLOW: 'Dose stopped — no solution moved',
  TIMEOUT: 'Dose stopped — time limit',
  INTERLOCK: 'Dose stopped — safety lock',
  NO_DOSER: 'Dose stopped — pump not available',
  PUMP_ERROR: 'Dose stopped — pump driver error',
  STOCK_LOW: 'Stock bottle low',
  HAL_ERROR: 'Hardware error',
  ACTUATOR_FAULT: 'Device did not switch',
  STAGE_CHANGED: 'Growth stage changed',
  HARVEST_DUE: 'Harvest due',
  CLOUD_NOT_CONFIGURED: 'Cloud server not set up',
  CLOUD_UNREACHABLE: 'Cloud server not reachable',
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
  LOAD_CELL_FAULT: ['Check the four HX711 wires at the Pi: DT (GPIO6), SCK (GPIO13), VCC (3.3 V) and GND',
    'Live → Stock should show a weight again within 30 s', 'Then dose again from Nutrients'],
  NO_FLOW: ['Check the stock bottle is not empty', 'Check the tube is not kinked and its end is in the solution',
    'Prime the pump to clear air from the line', 'Then dose again'],
  TIMEOUT: ['Check the pump runs and the tube is not partly blocked', 'Dose again; the part already delivered is in the Doses list'],
  INTERLOCK: ['Clear the lock first (refill the reservoir, check the float switch or release the emergency stop)',
    'Dose again; the part already delivered is in the Doses list'],
  NO_DOSER: ['Check the dosing pump is in the registry and its relay channel is wired'],
  PUMP_ERROR: ['Read the controller log: journalctl -u greenhouse-control', 'Check the dosing pump relay wiring'],
  STOCK_LOW: ['Mix a new batch of stock solution and refill the bottle'],
  ACTUATOR_FAULT: ['Check the relay board has its 5 V supply (its power LED is lit)', 'Check the wire from the Pi to the relay input named in the message',
    'Test the relay on its own: ghctl hw relay IN7 --seconds 2 (use the input from the message)', 'Read the controller log: journalctl -u greenhouse-control -n 50'],
  ESTOP: ['Find out why the emergency stop was pressed and fix that first', 'Then press Auto on each device in Controls to hand it back to the controller',
    'Devices not set back to Auto return to automatic by themselves after 30 min'],
  CONTROLLER_OFFLINE: ['Check the Pi has power (red LED) and the display is on', 'On the Pi: systemctl status greenhouse-control',
    'Safety rules keep running on the Pi even when the app cannot reach it'],
  HAL_ERROR: ['Read the controller log: journalctl -u greenhouse-control -n 50', 'Check the wiring of the part named in the message'],
  STAGE_CHANGED: ['Check the new stage\'s thresholds on the Thresholds screen', 'Make sure the new irrigation circuit (fog, drip or sprinkler) is connected',
    'To undo, pick the previous stage in Thresholds → Growth stage'],
  HARVEST_DUE: ['Harvest the crop', 'Then start a new crop: Thresholds → Growth stage → Start new crop'],
  CLOUD_NOT_CONFIGURED: ['Set up the server: More → Settings → Cloud (administrator)', 'Or on the greenhouse display: press N → Cloud server',
    'Or on the controller: sudo ghctl cloud setup https://<server>'],
  CLOUD_UNREACHABLE: ['Check the controller has internet (display: press N)', 'Check the cloud server is running',
    'Nothing is lost: uploads resume by themselves when the connection returns'],
};
