"""Real hardware on the Raspberry Pi 5. Pins and channels come from the registry.

NOT YET RUN ON HARDWARE. Written against the Assembly Procedures and the Gate 1/2
checklists; verify each driver on the bench (Gate 1, Gate 2) before trusting it.
Libraries are imported lazily so the rest of the controller runs on any machine.
Install with:  pip install -e ".[pi]"   (gpiozero + lgpio; RPi.GPIO does not work on the Pi 5)
"""
from __future__ import annotations

import glob
import logging
import threading
import time
from typing import Callable

from ..registry import ActuatorDef, Registry, SensorDef
from . import DoseResult, Hal, RawSample

log = logging.getLogger(__name__)


def _gpio_num(pin: str | int) -> int:
    return int(str(pin).upper().replace("GPIO", ""))


def rp1_chip() -> int:
    """The gpiochip that carries the 40-pin header on a Pi 5.

    Older Bookworm kernels exposed it as gpiochip4; kernels from late 2024 renumbered it to
    gpiochip0. Look it up by label instead of assuming either."""
    import lgpio
    for n in range(0, 8):
        try:
            h = lgpio.gpiochip_open(n)
        except Exception:
            continue
        try:
            info = lgpio.gpio_get_chip_info(h)
            label = str(info[2]).lower() if len(info) > 2 else ""
            if "rp1" in label:
                return n
        finally:
            lgpio.gpiochip_close(h)
    return 0


class PiHal(Hal):
    def __init__(self, reg: Registry):
        from gpiozero import Device, OutputDevice
        from gpiozero.pins.lgpio import LGPIOFactory

        Device.pin_factory = LGPIOFactory(chip=rp1_chip())
        self.reg = reg
        self._lock = threading.RLock()
        self._outputs: dict[str, list] = {}
        active_low = bool(reg.relay_board.get("active_low", True))
        inputs = reg.relay_board.get("inputs", {})
        self._pca = None
        for a in reg.physical_actuators:
            if not a.installed:
                continue
            if a.kind == "relay":
                chans = [a.extra["channel"]] + list(a.extra.get("also", []) or [])
                # initial_value=False → relay OFF from the first instant, whatever the board polarity.
                self._outputs[a.id] = [OutputDevice(_gpio_num(inputs[c]), active_high=not active_low,
                                                    initial_value=False) for c in chans]
            elif a.kind == "ssr":
                self._outputs[a.id] = [OutputDevice(_gpio_num(a.extra["pin"]), active_high=True, initial_value=False)]
            elif a.kind == "stepper":
                self._step = OutputDevice(_gpio_num(a.extra["step_pin"]), initial_value=False)
                self._dir = OutputDevice(_gpio_num(a.extra["dir_pin"]), initial_value=False)
                self._auger = a
        self._sensors: dict[str, object] = {}
        self._flow_pulses = 0
        self._flow_t = time.monotonic()

    # ── outputs ──────────────────────────────────────────────────────────
    def _pca9685(self):
        if self._pca is None:
            import board
            import busio
            from adafruit_pca9685 import PCA9685

            self._pca = PCA9685(busio.I2C(board.SCL, board.SDA))
            self._pca.frequency = 50
        return self._pca

    def set_output(self, adef: ActuatorDef, on: bool) -> None:
        with self._lock:
            if adef.kind in ("relay", "ssr"):
                for dev in self._outputs.get(adef.id, []):
                    dev.on() if on else dev.off()
            elif adef.kind == "servo":
                pulse_us = float(adef.extra["open_pulse_us" if on else "closed_pulse_us"])
                ch = self._pca9685().channels[int(adef.extra["pca9685_channel"])]
                ch.duty_cycle = int(pulse_us / 20000.0 * 0xFFFF)   # 50 Hz → 20 ms period
            elif adef.kind == "stepper":
                pass  # the auger only moves inside dose()
            else:
                raise ValueError(f"unsupported actuator kind {adef.kind}")

    # ── dosing (closed loop against the load cell, §4.3) ─────────────────
    def dose(self, target_g: float, tolerance_g: float, max_time_s: float,
             interlocks_clear: Callable[[], bool]) -> DoseResult:
        hopper = next(s for s in self.reg.sensors if s.type == "hopper_weight")
        steps = int(self._auger.extra.get("steps_per_increment", 50))

        def mass() -> float | None:
            return self._hx711_grams(hopper, samples=10)

        start = mass()
        if start is None:
            return DoseResult(0.0, "aborted", "LOAD_CELL_FAULT")
        t0 = time.monotonic()
        delivered = 0.0
        self._dir.on()
        while delivered < target_g - tolerance_g:
            if not interlocks_clear():
                return DoseResult(delivered, "aborted", "INTERLOCK")
            if time.monotonic() - t0 > max_time_s:
                return DoseResult(delivered, "aborted", "AUGER_JAM")
            for _ in range(steps):
                self._step.on(); time.sleep(0.001); self._step.off(); time.sleep(0.001)
            time.sleep(0.5)   # let the material settle
            m = mass()
            if m is not None:
                delivered = start - m
        return DoseResult(round(delivered, 1), "complete", "")

    # ── sensors ──────────────────────────────────────────────────────────
    def read_local(self, sensors: list[SensorDef]) -> list[RawSample]:
        out = []
        for sd in sensors:
            try:
                raw = self._read(sd)
                out.append(RawSample(sd.id, raw, raw is not None, None if raw is not None else "no data"))
            except Exception as e:  # a failed read is INVALID, never zero
                log.warning("read %s failed: %s", sd.id, e)
                out.append(RawSample(sd.id, None, False, str(e)[:120]))
        return out

    def _read(self, sd: SensorDef) -> float | None:
        dev = sd.extra.get("device", "")
        if dev == "mhz19b":
            return self._mhz19b(sd.extra["port"])
        if dev.startswith("ads1115"):
            return self._ads1115(dev, sd.extra["channel"])
        if dev == "ds18b20":
            return self._ds18b20(sd)
        if dev == "ultrasonic_uart":
            return self._ultrasonic_level(sd)
        if dev == "hx711":
            return self._hx711_raw(sd)
        if dev == "float":
            return self._float(sd)
        if dev == "hall_flow":
            return self._flow(sd)
        raise ValueError(f"no driver for device '{dev}'")

    def _mhz19b(self, port: str) -> float | None:
        import serial
        with self._lock:
            ser = self._sensors.get(port)
            if ser is None:
                ser = serial.Serial(port, 9600, timeout=1.0)
                # Disable automatic baseline correction once (Assembly A10 step 6).
                cmd = bytes([0xFF, 0x01, 0x79, 0x00, 0, 0, 0, 0])
                ser.write(cmd + bytes([(0xFF - (sum(cmd[1:]) & 0xFF) + 1) & 0xFF]))
                ser.read(9)
                self._sensors[port] = ser
            ser.reset_input_buffer()
            ser.write(bytes([0xFF, 0x01, 0x86, 0, 0, 0, 0, 0, 0x79]))
            frame = ser.read(9)
        if len(frame) != 9 or frame[0] != 0xFF or frame[1] != 0x86:
            return None
        if (0xFF - (sum(frame[1:8]) & 0xFF) + 1) & 0xFF != frame[8]:
            return None   # checksum failure: discard, never log as zero
        return float(frame[2] * 256 + frame[3])

    def _ads1115(self, dev: str, channel: str) -> float:
        import board
        import busio
        import adafruit_ads1x15.ads1115 as ADS
        from adafruit_ads1x15.analog_in import AnalogIn

        with self._lock:
            ads = self._sensors.get(dev)
            if ads is None:
                addr = int(dev.split("@")[1], 16)
                ads = ADS.ADS1115(busio.I2C(board.SCL, board.SDA), address=addr)
                ads.gain = 1   # ±4.096 V
                self._sensors[dev] = ads
            pin = getattr(ADS, f"P{int(channel.upper().replace('A', ''))}")
            return round(AnalogIn(ads, pin).voltage, 5)

    def _ds18b20(self, sd: SensorDef) -> float | None:
        # Two probes share the 1-Wire bus; the first enumerated is used unless the registry names one.
        paths = sorted(glob.glob("/sys/bus/w1/devices/28-*/w1_slave"))
        want = sd.extra.get("address")
        if want:
            paths = [p for p in paths if want in p]
        if not paths:
            return None
        lines = open(paths[0]).read().splitlines()
        if len(lines) < 2 or not lines[0].strip().endswith("YES"):
            return None
        return int(lines[1].split("t=")[1]) / 1000.0

    def ultrasonic_distance_cm(self, sd: SensorDef) -> float | None:
        """Raw distance from the transducer, for finding the blind zone and the tank depth."""
        import serial
        port = sd.extra["port"]
        with self._lock:
            ser = self._sensors.get(port)
            if ser is None:
                ser = serial.Serial(port, 9600, timeout=1.0)
                self._sensors[port] = ser
            ser.reset_input_buffer()
            data = ser.read(8)
        for i in range(len(data) - 3):
            if data[i] == 0xFF and (sum(data[i:i + 3]) & 0xFF) == data[i + 3]:
                return (data[i + 1] * 256 + data[i + 2]) / 10.0
        return None

    def servo_pulse(self, channel: int, pulse_us: float) -> None:
        """Drive one PCA9685 channel at a given pulse width (0 = release), for finding travel limits."""
        with self._lock:
            ch = self._pca9685().channels[int(channel)]
            ch.duty_cycle = 0 if pulse_us <= 0 else int(pulse_us / 20000.0 * 0xFFFF)

    def jog(self, steps: int, reverse: bool = False, step_delay_s: float = 0.001) -> None:
        """Turn the auger a fixed number of steps (bench test of the stepper and driver)."""
        with self._lock:
            self._dir.off() if reverse else self._dir.on()
            for _ in range(int(steps)):
                self._step.on(); time.sleep(step_delay_s); self._step.off(); time.sleep(step_delay_s)

    def _ultrasonic_level(self, sd: SensorDef) -> float | None:
        """A02YYUW-style UART frame: 0xFF, high, low, checksum → distance in mm. Returns level %."""
        import serial
        port = sd.extra["port"]
        with self._lock:
            ser = self._sensors.get(port)
            if ser is None:
                ser = serial.Serial(port, 9600, timeout=1.0)
                self._sensors[port] = ser
            ser.reset_input_buffer()
            data = ser.read(8)
        for i in range(len(data) - 3):
            if data[i] == 0xFF and (sum(data[i:i + 3]) & 0xFF) == data[i + 3]:
                dist_cm = (data[i + 1] * 256 + data[i + 2]) / 10.0
                depth, blind = float(sd.extra["tank_depth_cm"]), float(sd.extra.get("blind_zone_cm", 25))
                if dist_cm < blind:
                    return None   # inside the blind zone the reading is meaningless
                return max(0.0, min(100.0, (depth - dist_cm) / (depth - blind) * 100.0))
        return None

    def _hx711_raw(self, sd: SensorDef, samples: int = 5) -> float | None:
        import lgpio
        dt, sck = _gpio_num(sd.extra["dt_pin"]), _gpio_num(sd.extra["sck_pin"])
        with self._lock:
            h = self._sensors.get("lgpio")
            if h is None:
                h = lgpio.gpiochip_open(rp1_chip())
                lgpio.gpio_claim_input(h, dt)
                lgpio.gpio_claim_output(h, sck, 0)
                self._sensors["lgpio"] = h
            vals = []
            for _ in range(samples):
                t0 = time.monotonic()
                while lgpio.gpio_read(h, dt) == 1:
                    if time.monotonic() - t0 > 0.5:
                        return None
                    time.sleep(0.001)
                v = 0
                for _ in range(24):
                    lgpio.gpio_write(h, sck, 1); v = (v << 1) | lgpio.gpio_read(h, dt); lgpio.gpio_write(h, sck, 0)
                lgpio.gpio_write(h, sck, 1); lgpio.gpio_write(h, sck, 0)   # 25th pulse: channel A, gain 128
                if v & 0x800000:
                    v -= 1 << 24
                vals.append(v)
        vals.sort()
        trimmed = vals[1:-1] if len(vals) > 3 else vals   # reject outliers
        return float(sum(trimmed) / len(trimmed))

    def _hx711_grams(self, sd: SensorDef, samples: int = 10) -> float | None:
        from ..calibration import apply
        raw = self._hx711_raw(sd, samples)
        consts = getattr(self, "hopper_constants", None)
        if raw is None or not consts:
            return None
        return apply("scale", raw, consts)

    def _float(self, sd: SensorDef) -> float:
        from gpiozero import Button
        with self._lock:
            b = self._sensors.get(sd.id)
            if b is None:
                b = Button(_gpio_num(sd.extra["pin"]), pull_up=True, bounce_time=0.2)
                self._sensors[sd.id] = b
        closed = b.is_pressed
        # Case B wiring: the contact OPENS on low water, so an open circuit (or a cut wire) reads LOW.
        low = (not closed) if sd.extra.get("low_when", "open") == "open" else closed
        return 0.0 if low else 1.0

    def _flow(self, sd: SensorDef) -> float:
        from gpiozero import DigitalInputDevice
        with self._lock:
            dev = self._sensors.get(sd.id)
            if dev is None:
                dev = DigitalInputDevice(_gpio_num(sd.extra["pin"]), pull_up=True)

                def _pulse():
                    self._flow_pulses += 1
                dev.when_activated = _pulse
                self._sensors[sd.id] = dev
            now = time.monotonic()
            pulses, dt = self._flow_pulses, now - self._flow_t
            self._flow_pulses, self._flow_t = 0, now
        ppl = float(sd.extra.get("pulses_per_litre", 450))
        return round(pulses / ppl / max(dt, 1e-3) * 60.0, 3)

    def close(self) -> None:
        for devs in self._outputs.values():
            for d in devs:
                try:
                    d.off(); d.close()
                except Exception:
                    pass
