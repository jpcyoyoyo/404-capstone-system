"""Control-loop tests, including the ten Gate 2 fault injections (Integration Plan §3.7).

Each test states which fault injection or Level 3 test case it covers.
"""
from __future__ import annotations

from datetime import timedelta

from greenhouse.control.engine import CommandIn, ControlEngine

from .conftest import T0


def on(engine: ControlEngine, aid: str) -> bool:
    return engine.state[aid].on


def advance(engine, feed, start, seconds, step=30, **vals):
    now = start
    res = None
    for _ in range(int(seconds // step)):
        now = now + timedelta(seconds=step)
        feed.all(now, **vals)
        res = engine.tick(now)
    return now, res


# ── Test 6 / 2.1.1: soil-moisture threshold with hysteresis ─────────────────
def test_irrigation_hysteresis(engine, feed):
    feed.all(T0, soil_moisture=55)             # below setpoint − deadband (62.5)
    res = engine.tick(T0)
    assert on(engine, "pump") and on(engine, "valve_drip") and on(engine, "servo_main")
    assert not on(engine, "valve_fog") and not on(engine, "valve_sprinkler")
    # valves open before the pump starts
    order = [c.actuator for c in res.changes if c.on]
    assert order.index("valve_drip") < order.index("pump")

    t = T0 + timedelta(seconds=60)
    feed.all(t, soil_moisture=67)              # inside the deadband → hold, no chatter
    res = engine.tick(t)
    assert on(engine, "pump") and not res.changes

    t += timedelta(seconds=60)
    feed.all(t, soil_moisture=74)              # above setpoint + deadband (72.5) → off
    res = engine.tick(t)
    assert not on(engine, "pump") and not on(engine, "valve_drip")
    offs = [c.actuator for c in res.changes if not c.on]
    assert offs[0] == "pump"                   # pump stops before valves close


def test_stage_selects_circuit(engine, feed):
    engine.set_stage("seedling")
    feed.all(T0, soil_moisture=60)             # seedling band 70–80
    engine.tick(T0)
    assert on(engine, "valve_fog") and not on(engine, "valve_drip")


# ── Fault 6 / Test 7 / 2.4.1: arbitration, temperature outranks CO₂ ────────
def test_high_temperature_beats_low_co2(engine, feed):
    feed.all(T0, temperature=33, co2=350)
    res = engine.tick(T0)
    assert on(engine, "fan_exhaust")
    sup = [s for s in res.suppressed if s.actuator == "fan_exhaust"]
    assert sup and sup[0].source == "co2" and sup[0].by_source == "temperature"
    assert res.new_suppressed                   # logged once …
    res2 = engine.tick(T0 + timedelta(seconds=30))
    assert res2.suppressed and not res2.new_suppressed   # … not every cycle


def test_ventilation_hysteresis_and_manual_override(engine, feed):
    # Test 9 / 3.2.2
    feed.all(T0, temperature=32)
    engine.tick(T0)
    assert on(engine, "fan_exhaust")
    t = T0 + timedelta(seconds=90)
    feed.all(t, temperature=29.5)               # below max but not below max − 1.5 → keeps running
    engine.tick(t)
    assert on(engine, "fan_exhaust")
    t += timedelta(seconds=60)
    feed.all(t, temperature=32)
    r = engine.command(CommandIn("c-fan-off", "fan_exhaust", "OFF", t, "admin"), t)
    assert r.status == "ACCEPTED"
    engine.tick(t)
    assert not on(engine, "fan_exhaust")        # manual OFF holds despite the breach
    t += timedelta(seconds=60)
    feed.all(t, temperature=32)
    engine.tick(t)
    assert not on(engine, "fan_exhaust")
    engine.command(CommandIn("c-fan-auto", "fan_exhaust", "AUTO", t, "admin"), t)
    engine.tick(t)
    assert on(engine, "fan_exhaust")            # back in automatic control


# ── Fault 1: one soil sensor forced to an invalid reading ──────────────────
def test_invalid_soil_sensor_excluded(engine, feed):
    feed.all(T0, soil_moisture=67)
    feed.one("soil_z1_01", None, T0, quality="INVALID")
    res = engine.tick(T0)
    soil = res.params["soil_moisture"]
    assert soil.zones[1].n_valid == 2 and not soil.zones[1].faulted
    assert soil.value == 67
    assert any(a.code == "SENSOR_INVALID" and a.severity == "low" for a in res.alerts)
    assert not on(engine, "pump")               # irrigation unaffected


# ── Fault 2: two of three sensors in a zone stale → MANUAL_REQUIRED ───────
def test_zone_manual_required(engine, feed):
    feed.all(T0, soil_moisture=67)
    old = T0 - timedelta(minutes=10)
    feed.one("soil_z2_01", 50, old)
    feed.one("soil_z2_02", 50, old)
    res = engine.tick(T0)
    soil = res.params["soil_moisture"]
    assert 2 in soil.manual_required_zones
    assert soil.value == 67                     # zone 2 excluded; zone 1 still drives irrigation
    assert any(a.code == "ZONE_MANUAL_REQUIRED" and a.severity == "high" for a in res.alerts)


def test_all_soil_faulted_suspends_auto_irrigation(engine, feed):
    feed.all(T0, soil_moisture=40)
    for sid in ["soil_z1_01", "soil_z1_02", "soil_z1_03", "soil_z2_01", "soil_z2_02", "soil_z2_03"]:
        feed.one(sid, None, T0, quality="INVALID")
    engine.tick(T0)
    assert not on(engine, "pump")


# ── Fault 3 / Test 11: water below minimum refuses every pump request ─────
def test_low_water_locks_out_pump(engine, feed):
    feed.all(T0, soil_moisture=40, float_switch=0)
    res = engine.tick(T0)
    assert not on(engine, "pump")
    assert res.lockouts["pump"] == "LOW_WATER"
    assert any(a.code == "LOW_WATER" for a in res.alerts)
    r = engine.command(CommandIn("c-irr", "irrigation", "ON", T0, "admin"), T0)
    assert r.status == "REJECTED" and r.reason == "LOW_WATER"


def test_low_water_stops_running_pump_immediately(engine, feed):
    feed.all(T0, soil_moisture=40)
    engine.tick(T0)
    assert on(engine, "pump")
    t = T0 + timedelta(seconds=5)               # well inside the 30 s minimum on-time
    feed.all(t, soil_moisture=40, float_switch=0)
    engine.tick(t)
    assert not on(engine, "pump")               # safety bypasses the timer


def test_float_switch_fault_is_fail_safe(engine, feed):
    feed.all(T0, soil_moisture=40)
    feed.one("float_01", None, T0, quality="INVALID")
    res = engine.tick(T0)
    assert res.lockouts["pump"] == "FLOAT_SWITCH_FAULT" and not on(engine, "pump")


# ── Fault 4: node offline → its sensors STALE ──────────────────────────────
def test_node_offline(engine, feed):
    feed.all(T0)
    engine.set_node_online("node_b", False)
    res = engine.tick(T0)
    assert any(a.code == "NODE_OFFLINE" for a in res.alerts)
    assert 2 in res.params["soil_moisture"].manual_required_zones


# ── Fault 5 / Test 8 step 4: irrigation held beyond 15 minutes ─────────────
def test_max_run_forces_off_with_cooldown(engine, feed):
    feed.all(T0, soil_moisture=40)
    engine.tick(T0)
    assert on(engine, "pump")
    now, res = advance(engine, feed, T0, 15 * 60, soil_moisture=40)
    assert not on(engine, "pump")
    assert any(a.code == "MAX_RUN_EXCEEDED" for a in res.alerts)
    now, _ = advance(engine, feed, now, 120, soil_moisture=40)
    assert not on(engine, "pump")               # cooldown still holds it off


# ── Fault 7 / Test 8 step 5: power loss → everything off at boot ───────────
def test_boot_deenergises_everything(engine, feed):
    feed.all(T0, soil_moisture=40)
    engine.tick(T0)
    assert on(engine, "pump")
    changes = engine.boot(T0 + timedelta(seconds=10))
    assert all(not c.on for c in changes)
    assert not any(st.on for st in engine.state.values())
    assert engine.irrigation_manual is None


# ── Fault 9: stale command expires ─────────────────────────────────────────
def test_command_expires_after_60s(engine, feed):
    feed.all(T0)
    r = engine.command(CommandIn("c-old", "fan_exhaust", "ON", T0 - timedelta(seconds=61), "admin"), T0)
    assert r.status == "EXPIRED"


# ── Fault 10: duplicate command id executes once ───────────────────────────
def test_duplicate_command_is_idempotent(engine, feed):
    feed.all(T0)
    c = CommandIn("c-dup", "irrigation", "ON", T0, "admin", duration_s=120)
    r1 = engine.command(c, T0)
    engine.tick(T0)
    assert r1.status == "ACCEPTED" and on(engine, "pump")
    until = engine.irrigation_manual["until"]
    r2 = engine.command(c, T0 + timedelta(seconds=30))
    assert r2 is r1 and engine.irrigation_manual["until"] == until


# ── Actuator protection and contention ─────────────────────────────────────
def test_min_off_time_defers(engine, feed):
    feed.all(T0, soil_moisture=40)
    engine.tick(T0)
    t, _ = advance(engine, feed, T0, 60, soil_moisture=80)      # off after min-on
    assert not on(engine, "pump")
    feed.all(t + timedelta(seconds=30), soil_moisture=40)
    res = engine.tick(t + timedelta(seconds=30))                  # 30 s after stopping < 120 s min-off
    assert not on(engine, "pump")
    assert any(d.actuator == "pump" and d.reason == "MIN_OFF_TIME" for d in res.deferred)


def test_pump_needs_an_open_valve(engine, feed):
    feed.all(T0)
    r = engine.command(CommandIn("c-pump", "pump", "ON", T0, "admin"), T0)
    assert r.status == "REJECTED" and r.reason == "NO_OPEN_VALVE"


def test_one_circuit_at_a_time(engine, feed):
    feed.all(T0)
    assert engine.command(CommandIn("c1", "valve_drip", "ON", T0, "admin"), T0).status == "ACCEPTED"
    engine.tick(T0)
    r = engine.command(CommandIn("c2", "valve_fog", "ON", T0, "admin"), T0)
    assert r.status == "REJECTED" and r.reason == "PUMP_BUSY"


def test_manual_irrigation_expires(engine, feed):
    feed.all(T0)
    engine.command(CommandIn("c-irr", "irrigation", "ON", T0, "admin", duration_s=60), T0)
    engine.tick(T0)
    assert on(engine, "pump")
    t = T0 + timedelta(seconds=90)
    feed.all(t)
    res = engine.tick(t)
    assert not on(engine, "pump")
    assert ("irrigation", "AUTO", "manual override expired") in res.mode_changes


# ── Test 10 step 4: fertigation gating ─────────────────────────────────────
def test_fertigation_gated_when_soil_wet(engine, feed):
    feed.all(T0, soil_moisture=76)             # at/above growth max 75
    r = engine.command(CommandIn("c-dose", "auger", "DOSE", T0, "admin", target_g=20), T0)
    assert r.status == "REJECTED" and r.reason == "FERTIGATION_GATED"
    feed.all(T0, soil_moisture=65)
    r = engine.command(CommandIn("c-dose2", "auger", "DOSE", T0, "admin", target_g=20), T0)
    assert r.status == "ACCEPTED" and r.dose_g == 20
    r = engine.command(CommandIn("c-dose3", "auger", "DOSE", T0, "admin", target_g=20), T0)
    assert r.reason == "DOSING"


def test_lights_follow_photoperiod(engine, feed):
    feed.all(T0, light=5000)
    engine.tick(T0)
    assert on(engine, "lights")
    night = T0 + timedelta(hours=10)            # 20:00 local
    feed.all(night, light=5000)
    engine.tick(night)
    assert not on(engine, "lights")


def test_not_installed_actuator_rejected(raw_registry):
    from .conftest import make_registry
    reg = make_registry(raw_registry, install_all=False)   # exhaust fan not installed in the registry
    e = ControlEngine(reg, T0)
    r = e.command(CommandIn("c", "fan_exhaust", "ON", T0, "admin"), T0)
    assert r.status == "REJECTED" and r.reason == "NOT_INSTALLED"


def test_emergency_stop(engine, feed):
    feed.all(T0, soil_moisture=40, temperature=33)
    engine.tick(T0)
    assert on(engine, "pump") and on(engine, "fan_exhaust")
    changes = engine.estop(T0 + timedelta(seconds=2), "admin")
    assert {c.actuator for c in changes} >= {"pump", "fan_exhaust"}
    assert changes[0].actuator == "pump"
    feed.all(T0 + timedelta(seconds=60), soil_moisture=40, temperature=33)
    engine.tick(T0 + timedelta(seconds=60))
    assert not on(engine, "pump") and not on(engine, "fan_exhaust")


def test_auger_off_requests_dose_stop(engine, feed):
    feed.all(T0, soil_moisture=65)
    assert engine.command(CommandIn("d1", "auger", "DOSE", T0, "admin", target_g=50), T0).status == "ACCEPTED"
    r = engine.command(CommandIn("d2", "auger", "OFF", T0, "admin"), T0)
    assert r.status == "ACCEPTED" and engine.dose_stop_requested
    engine.dose_finished(T0)
    assert not engine.dose_stop_requested and not engine.dosing
