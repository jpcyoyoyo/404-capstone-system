"""Plain words for why a device command was refused or a device could not switch.

Used in command acks (the app's toast), the activity log, alerts and `ghctl`. The app has the same
wording in app/src/contract/codes.ts (REASON_TEXT); keep the two in step. Dose stops have their own
wording in fertigation.py (STOP_TEXT).
"""
from __future__ import annotations

# Each text reads on its own after "<device>: not switched on — ".
REASON_TEXT = {
    "LOW_WATER": "the reservoir water is too low, so the pump and valves are locked. Refill the reservoir; the lock clears by itself",
    "FLOAT_SWITCH_FAULT": "the float switch gives no reading, so the pump is locked off to be safe. Check the float switch and its wire (GPIO19)",
    "NOT_INSTALLED": "this device is not installed yet (installed: false in the registry)",
    "MIN_OFF_TIME": "it was switched off moments ago and has to stay off a little longer to protect it",
    "MIN_ON_TIME": "it was switched on moments ago and has to stay on a little longer to protect it",
    "COOLDOWN": "it is cooling down after a long run",
    "DAILY_CAP": "it has reached its run-time limit for today; it can run again after midnight",
    "MAX_RUN_EXCEEDED": "it ran for its maximum time and was stopped",
    "NO_OPEN_VALVE": "no irrigation valve is open. Use Water now, which opens a valve before starting the pump",
    "PUMP_BUSY": "another irrigation circuit is running; only one circuit runs at a time",
    "DOSING": "a fertilizer dose is already running",
    "FERTIGATION_GATED": "fertilizer is held back because the soil is already wet or the EC is already high",
    "STOCK_LOW": "there is not enough stock solution in the bottle for that dose. Mix a new batch",
    "BAD_ACTION": "that action does not apply to this device",
    "BAD_TARGET": "the dose must be more than 0 g and at most 200 g",
    "UNKNOWN_ACTUATOR": "the controller does not know this device (check contract/registry.yaml)",
    "UNKNOWN_CIRCUIT": "there is no valve for that irrigation circuit",
    "MANUAL_ONLY": "this valve is turned by hand",
    "EXPIRED": "the command reached the controller too late, so nothing was changed. Try again",
    "CONTROLLER_TIMEOUT": "the control service did not answer, so nothing was changed. Check it is running (journalctl -u greenhouse-control)",
    "REMOTE_READ_ONLY": "devices can only be controlled on the greenhouse network for now",
    "ACTUATOR_FAULT": "the controller could not drive its output",
}

# Short words for a lockout inside a longer line ("safety lock: reservoir water too low").
LOCK_WORD = {"LOW_WATER": "reservoir water too low", "FLOAT_SWITCH_FAULT": "float switch not reading",
             "DOSING": "a dose is running", "NOT_INSTALLED": "not installed"}

# What a refused command would have done, for the start of the sentence.
VERB = {"ON": "not switched on", "OFF": "not switched off", "AUTO": "not returned to automatic",
        "DOSE": "dose not started", "ESTOP": "emergency stop not done"}


def reason_text(code: str | None) -> str:
    if not code:
        return "it was refused"
    return REASON_TEXT.get(code, code.replace("_", " ").lower())


def wait_text(seconds: float | None) -> str:
    """'45 s', '2 min 5 s', '5 min'."""
    s = max(0, int(round(seconds or 0)))
    if s < 60:
        return f"{s} s"
    m, r = divmod(s, 60)
    return f"{m} min {r} s" if r else f"{m} min"


def refusal(name: str, action: str, code: str | None, retry_s: float | None = None, detail: str | None = None) -> str:
    """One sentence for a refused command: 'Grow lights: not switched on — it was switched off moments
    ago and has to stay off a little longer to protect it. Try again in 4 min 10 s.'"""
    text = f"{name}: {VERB.get(action, 'not done')} — {reason_text(code)}"
    if detail:
        text += f" ({detail})"
    text += "."
    if retry_s:
        text += f" Try again in {wait_text(retry_s)}."
    return text


def output_fault(name: str, on: bool, where: str | None, error: Exception | str) -> str:
    """Alert text when the relay, SSR or servo output itself failed."""
    at = f" ({where})" if where else ""
    return (f"{name} could not be switched {'on' if on else 'off'}: the controller could not drive its output{at}. "
            f"Check the relay board's 5 V supply and the wire to {where or 'the output'}. Error: {error}")


def output_where(extra: dict) -> str | None:
    """Where a device is wired, from its registry entry: relay input, SSR pin or servo channel."""
    if extra.get("channel"):
        return f"relay {extra['channel']}"
    if extra.get("pin"):
        return f"SSR on {extra['pin']}"
    if extra.get("pca9685_channel") is not None:
        return f"servo channel {extra['pca9685_channel']}"
    return None


def deferred_text(target_on: bool, code: str, retry_s: float | None) -> str:
    """Activity-log line for an automatic switch that has to wait."""
    what = "waiting to switch on" if target_on else "waiting to switch off"
    why = {"MIN_OFF_TIME": "minimum off time", "MIN_ON_TIME": "minimum on time", "COOLDOWN": "cooling down after a long run",
           "DAILY_CAP": "run-time limit for today reached"}.get(code, reason_text(code))
    return f"{what}: {why}" + (f", {wait_text(retry_s)} left" if retry_s else "")


# ── sensors ──────────────────────────────────────────────────────────────
SENSOR_WORD = {
    "temperature": "Air temperature sensor", "humidity": "Humidity sensor", "soil_moisture": "Soil moisture probe",
    "light": "Light sensor", "co2": "CO₂ sensor", "ph": "pH probe", "ec": "EC probe",
    "water_temperature": "Water temperature probe", "water_level": "Reservoir level sensor", "water_flow": "Flow sensor",
    "stock_weight": "Load cell under the stock bottle", "float_switch": "Float switch",
}
HOST_WORD = {"pi": "the controller", "node_a": "Node A", "node_b": "Node B"}


def sensor_label(sd) -> str:
    """'Soil moisture probe in zone 1 (soil_z1_02)'."""
    where = f" in zone {sd.zone}" if sd.zone else ""
    return f"{SENSOR_WORD.get(sd.type, sd.type.replace('_', ' ').capitalize())}{where} ({sd.id})"


def sensor_wiring(sd) -> str:
    """Where to look: 'its wires to the HX711 (DT GPIO6, SCK GPIO13, VCC, GND)', 'its wire to GPIO18'."""
    x = sd.extra
    if x.get("dt_pin"):
        return f"its wires to the HX711 (DT {x['dt_pin']}, SCK {x.get('sck_pin', '?')}, VCC, GND)"
    if x.get("channel"):
        return f"its wire to the ADS1115 input {x['channel']} on {HOST_WORD.get(sd.host, sd.host)}"
    if x.get("pin"):
        return f"its wire to {x['pin']} on {HOST_WORD.get(sd.host, sd.host)}"
    return "its wire"


def sensor_invalid(sd) -> str:
    return (f"{sensor_label(sd)} gives no usable reading (missing or impossible), so it is left out until it reads "
            f"normally again. Check the sensor and {sensor_wiring(sd)}.")


def sensor_stale(sd, cycles: int | None = None) -> str:
    since = f"for {cycles} cycles" if cycles else "since the controller started"
    node = "" if sd.host == "pi" else f" Check {HOST_WORD.get(sd.host, sd.host)} has power and Wi-Fi."
    return f"{sensor_label(sd)} has sent no reading {since}.{node} Check {sensor_wiring(sd)}."


def sensor_uncalibrated(sd) -> str:
    return f"{sensor_label(sd)} needs calibration before it is used for control (More → Calibration)."
