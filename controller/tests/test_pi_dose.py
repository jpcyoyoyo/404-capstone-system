"""PiHal's pulse-and-weigh dose loop, against a fake pump and load cell (no GPIO needed)."""
import threading

import greenhouse.hal.pi as pimod
from greenhouse.hal.pi import PiHal


class FakePump:
    def __init__(self):
        self.is_on, self.on_time, self._t = False, 0.0, None

    def on(self):
        self.is_on = True

    def off(self):
        self.is_on = False


def make(reg, monkeypatch, g_per_s=1.2, blocked=False):
    hal = PiHal.__new__(PiHal)
    hal.reg, hal._lock, hal._drives_outputs = reg, threading.RLock(), True
    hal._doser = reg.actuator("doser")
    pump = FakePump()
    hal._doser_dev = pump
    state = {"g": 1500.0}
    clock = {"t": 0.0}

    def sleep(s):
        clock["t"] += s
        if pump.is_on and not blocked:
            state["g"] -= g_per_s * s
    monkeypatch.setattr(pimod.time, "sleep", sleep)
    monkeypatch.setattr(pimod.time, "monotonic", lambda: clock["t"])
    hal._hx711_grams = lambda sd, samples=10: round(state["g"], 1)
    return hal, pump, state


def test_pi_dose_reaches_target_without_overshoot(reg, monkeypatch):
    hal, pump, state = make(reg, monkeypatch)
    r = hal.dose(200, 5, 600, lambda: True)
    assert r.status == "complete"
    assert 195 <= r.delivered_g <= 201          # shrinking pulses: at most a fraction of a pulse over
    assert not pump.is_on


def test_pi_dose_no_flow_and_pump_left_off(reg, monkeypatch):
    hal, pump, state = make(reg, monkeypatch, blocked=True)
    r = hal.dose(200, 5, 600, lambda: True)
    assert r.status == "aborted" and r.reason == "NO_FLOW" and not pump.is_on


def test_pi_dose_interlock_stops_pump(reg, monkeypatch):
    hal, pump, state = make(reg, monkeypatch)
    calls = {"n": 0}

    def clear():
        calls["n"] += 1
        return calls["n"] < 4
    r = hal.dose(200, 5, 600, clear)
    assert r.status == "aborted" and r.reason == "INTERLOCK" and not pump.is_on and r.delivered_g > 0


def test_pi_dose_load_cell_fault_before_pump(reg, monkeypatch):
    hal, pump, state = make(reg, monkeypatch)
    hal._hx711_grams = lambda sd, samples=10: None     # DT unplugged: no reading at all
    r = hal.dose(50, 5, 600, lambda: True)
    assert r.status == "aborted" and r.reason == "LOAD_CELL_FAULT" and r.delivered_g == 0 and not pump.is_on


def test_dose_outcome_in_plain_words():
    from greenhouse.fertigation import outcome_text, stop_text
    msg = outcome_text(5, 0, "aborted", "LOAD_CELL_FAULT")
    assert msg.startswith("Dose of 5 g stopped with nothing delivered: the load cell under the stock bottle gave no reading")
    assert "LOAD_CELL_FAULT" not in msg
    assert outcome_text(20, 7.5, "aborted", "NO_FLOW").startswith("Dose of 20 g stopped after 7.5 of 20 g: the pump ran")
    assert outcome_text(20, 19.8, "complete", "") == "Dose of 20 g complete: 19.8 g delivered."
    assert stop_text("SOMETHING_NEW") == "something new"
