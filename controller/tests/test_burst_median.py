"""burst_median: one ADS1115 reading from a burst of samples (CAP A15, 15 Nov 2026)."""
import greenhouse.hal.pi as pimod
from greenhouse.hal.pi import burst_median


def feeder(values):
    it = iter(values)
    return lambda: next(it)


def test_single_sample_reads_once(monkeypatch):
    slept = []
    monkeypatch.setattr(pimod.time, "sleep", slept.append)
    assert burst_median(feeder([1.234567]), 1, 0.04) == 1.23457
    assert slept == []


def test_median_rejects_short_spikes(monkeypatch):
    monkeypatch.setattr(pimod.time, "sleep", lambda s: None)
    # 15 Nov run in pH 6.86: about 1.32–1.34 V with spikes to 1.5–1.7 V
    vals = [1.33, 1.32, 1.69, 1.34, 1.33, 1.61, 1.33, 1.32, 1.34, 1.33, 1.54]
    assert burst_median(feeder(vals), len(vals), 0.04) == 1.33


def test_burst_spacing(monkeypatch):
    slept = []
    monkeypatch.setattr(pimod.time, "sleep", slept.append)
    burst_median(feeder([1.0] * 25), 25, 0.04)
    assert slept == [0.04] * 24


def test_registry_gives_ph_a_burst(reg):
    sd = reg.sensor("ph_01")
    assert int(sd.extra["samples"]) == 25
    assert "samples" not in reg.sensor("ec_01").extra
