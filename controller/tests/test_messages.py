"""Refused commands and device faults are explained in plain words (11 Oct 2026)."""
from __future__ import annotations

from datetime import timedelta

from greenhouse import messages as M
from greenhouse.control.engine import CommandIn

from .conftest import T0


def test_refusals_name_the_device_and_say_why(engine, feed):
    feed.all(T0, soil_moisture=40, float_switch=0)
    engine.tick(T0)
    r = engine.command(CommandIn("m1", "irrigation", "ON", T0, "admin"), T0)
    assert r.reason == "LOW_WATER"
    assert r.message.startswith("Irrigation: not switched on — the reservoir water is too low")
    assert "LOW_WATER" not in r.message

    feed.all(T0)
    r = engine.command(CommandIn("m2", "pump", "ON", T0, "admin"), T0)
    assert r.message.startswith("Pressure washer: not switched on — no irrigation valve is open")


def test_refusal_says_when_to_try_again(engine, feed):
    feed.all(T0)
    assert engine.command(CommandIn("m3", "lights", "ON", T0, "admin"), T0).status == "ACCEPTED"
    engine.tick(T0)
    t = T0 + timedelta(seconds=20)
    r = engine.command(CommandIn("m4", "lights", "OFF", t, "admin"), t)
    assert r.reason == "MIN_ON_TIME"
    assert r.message.startswith("Grow lights: not switched off — it was switched on moments ago")
    assert r.message.endswith("Try again in 4 min 40 s.")


def test_accepted_message_is_plain(engine, feed):
    feed.all(T0)
    r = engine.command(CommandIn("m5", "lights", "ON", T0, "admin", duration_s=300), T0)
    assert r.message == "Grow lights on for 5 min, then back to automatic."


def test_wait_and_deferred_text():
    assert M.wait_text(45) == "45 s" and M.wait_text(125) == "2 min 5 s" and M.wait_text(300) == "5 min"
    assert M.deferred_text(True, "MIN_OFF_TIME", 30) == "waiting to switch on: minimum off time, 30 s left"


def test_output_fault_says_where_to_look(reg):
    fan = reg.actuator("fan_exhaust")
    text = M.output_fault(fan.name, True, M.output_where(fan.extra), OSError("GPIO busy"))
    assert text.startswith("Exhaust fan could not be switched on") and "relay IN7" in text and "GPIO busy" in text


def test_sensor_alerts_name_the_part_and_the_wires(reg):
    text = M.sensor_invalid(reg.sensor("stock_01"))
    assert text.startswith("Load cell under the stock bottle (stock_01) gives no usable reading")
    assert "DT GPIO6, SCK GPIO13" in text
    assert "Node A has power" in M.sensor_stale(reg.sensor("soil_z1_02"), 3)
