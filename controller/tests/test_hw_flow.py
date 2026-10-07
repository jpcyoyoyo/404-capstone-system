"""`hw flow`: counts pulses for the bucket test and suggests pulses_per_litre."""
import greenhouse.hwcheck as hw


class FakeHal:
    def __init__(self, per_tick):
        self.total, self.per_tick = 0, per_tick

    def flow_pulse_total(self, sd):
        return self.total


def run(reg, monkeypatch, capsys, per_tick, ticks, litres):
    hal = FakeHal(per_tick)
    clock = {"t": 0.0}

    def sleep(s):
        clock["t"] += s
        hal.total += per_tick
    monkeypatch.setattr(hw.time, "sleep", sleep)
    monkeypatch.setattr(hw.time, "monotonic", lambda: clock["t"])
    hw.cmd_flow(reg, hal, "flow_01", ticks, litres)
    return capsys.readouterr().out


def test_flow_count_within_tolerance(reg, monkeypatch, capsys):
    out = run(reg, monkeypatch, capsys, per_tick=75, ticks=60, litres=10)   # 4500 pulses = 10 L at 450/L
    assert "total: 4500 pulses = 10.00 L" in out
    assert "450 pulses per litre; reading error +0.0 %" in out
    assert "set pulses_per_litre" not in out


def test_flow_count_suggests_new_constant(reg, monkeypatch, capsys):
    out = run(reg, monkeypatch, capsys, per_tick=60, ticks=60, litres=10)   # 3600 pulses for 10 L
    assert "360 pulses per litre" in out and "set pulses_per_litre: 360" in out


def test_flow_no_pulses(reg, monkeypatch, capsys):
    out = run(reg, monkeypatch, capsys, per_tick=0, ticks=5, litres=10)
    assert "no pulses counted" in out
