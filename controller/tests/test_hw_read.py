"""`hw read --count N` ends with a MEAN RAW line (mean and spread), used for the A8 load-cell tests."""
import greenhouse.hwcheck as hw
from greenhouse.hal import RawSample


class FakeHal:
    def __init__(self, raws):
        self.raws = list(raws)

    def read_local(self, sensors):
        r = self.raws.pop(0)
        return [RawSample("stock_01", r, r is not None, None if r is not None else "timeout")]


def run(reg, monkeypatch, capsys, raws):
    monkeypatch.setattr(hw.time, "sleep", lambda s: None)
    hw.cmd_read(reg, FakeHal(raws), None, ["stock_01"], len(raws), 1.0)
    return capsys.readouterr().out


def test_mean_and_spread(reg, monkeypatch, capsys):
    out = run(reg, monkeypatch, capsys, [-568490, -568430, None, -568550])
    assert "stock_01     MEAN RAW -568490  spread 120  (min -568550, max -568430, 3 valid)" in out


def test_single_reading_has_no_summary(reg, monkeypatch, capsys):
    assert "MEAN RAW" not in run(reg, monkeypatch, capsys, [-568490])


def test_no_valid_readings(reg, monkeypatch, capsys):
    assert "MEAN RAW —  (no valid readings)" in run(reg, monkeypatch, capsys, [None, None])
