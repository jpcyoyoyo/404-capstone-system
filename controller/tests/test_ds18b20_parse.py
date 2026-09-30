"""DS18B20 w1_slave parsing: a disconnected data line must never become a 0 °C reading (A5 T6)."""
from greenhouse.hal.pi import _ds18b20_temp


def test_real_reading():
    assert _ds18b20_temp(["c5 01 4b 46 7f ff 0c 10 21 : crc=21 YES", "c5 01 4b 46 7f ff 0c 10 21 t=28312"]) == 28.312


def test_real_zero_degrees_is_kept():
    # ice point: temperature bytes are 00 00 but the configuration bytes are not
    assert _ds18b20_temp(["00 00 4b 46 7f ff 00 10 f5 : crc=f5 YES", "00 00 4b 46 7f ff 00 10 f5 t=0"]) == 0.0


def test_disconnected_all_zero_is_rejected():
    # an all-zero scratchpad passes the CRC (0x00), so the kernel says YES and t=0
    assert _ds18b20_temp(["00 00 00 00 00 00 00 00 00 : crc=00 YES", "00 00 00 00 00 00 00 00 00 t=0"]) is None


def test_all_ones_is_rejected():
    assert _ds18b20_temp(["ff ff ff ff ff ff ff ff ff : crc=ff YES", "ff ff ff ff ff ff ff ff ff t=-62"]) is None
