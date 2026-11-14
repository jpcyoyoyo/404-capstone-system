"""Quality flags: full-scale readings (9 Nov 2026) and the CO2 warm-up."""
from datetime import timedelta

from greenhouse import quality

from .conftest import T0


def co2(reg, raw, *, since_start_s=600, ok=True):
    sd = reg.sensor("co2_01")
    return quality.evaluate(sd, raw, ok, None, T0, T0 - timedelta(seconds=since_start_s))


def test_registry_sets_mhz19b_full_scale(reg):
    assert float(reg.sensor("co2_01").extra["full_scale"]) == 5000


def test_co2_at_full_scale_is_invalid(reg):
    # 7-9 Nov 2026: 36 readings of exactly 5000 ppm were stored VALID.
    assert co2(reg, 5000.0) == (None, "INVALID")


def test_co2_above_full_scale_is_invalid(reg):
    assert co2(reg, 5001.0) == (None, "INVALID")


def test_co2_just_below_full_scale_is_valid(reg):
    assert co2(reg, 4999.0) == (4999.0, "VALID")


def test_normal_co2_is_valid(reg):
    assert co2(reg, 404.0) == (404.0, "VALID")


def test_full_scale_during_warmup_is_invalid_not_warming(reg):
    # The 5 WARMING rows at 5000 ppm would now be INVALID with the value cleared.
    assert co2(reg, 5000.0, since_start_s=30) == (None, "INVALID")


def test_normal_co2_during_warmup_is_warming(reg):
    assert co2(reg, 404.0, since_start_s=30) == (404.0, "WARMING")


def test_below_plausible_range_still_invalid(reg):
    assert co2(reg, 250.0) == (None, "INVALID")


def test_failed_read_still_invalid(reg):
    assert co2(reg, None, ok=False) == (None, "INVALID")


def test_sensor_without_full_scale_unchanged(reg):
    sd = next(s for s in reg.sensors if s.type == "temperature")
    assert "full_scale" not in sd.extra
    v, q = quality.evaluate(sd, 25.0, True, None, T0, T0 - timedelta(hours=1))
    assert (v, q) == (25.0, "VALID")
