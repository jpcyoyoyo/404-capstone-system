"""Network settings for the greenhouse display and the app (Wi-Fi profiles, hotspot, status).

On the Pi the work is done by /usr/local/sbin/greenhouse-netctl (deploy/network/greenhouse-netctl),
run through ``sudo -n``: the API runs as the unprivileged ``greenhouse`` account and a sudoers rule
(deploy/network/greenhouse-netctl.sudoers) lets it run that one helper and nothing else. Passwords go
to the helper on stdin, never on a command line.

Off the Pi (simulator, development, tests) :class:`SimNetwork` stands in so the screens can be used
and tested without NetworkManager.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from typing import Any, Protocol

HELPER = os.environ.get("GH_NETCTL", "/usr/local/sbin/greenhouse-netctl")
PROFILES = ("magso", "router")
PROFILE_LABEL = {"magso": "MAgSO Wi-Fi", "router": "Team router"}


class NetError(RuntimeError):
    pass


class Network(Protocol):
    def status(self) -> dict[str, Any]: ...
    def scan(self) -> list[dict[str, Any]]: ...
    def set_wifi(self, profile: str, ssid: str, password: str) -> dict[str, Any]: ...
    def forget(self, profile: str) -> dict[str, Any]: ...
    def hotspot(self) -> dict[str, Any]: ...


def validate(profile: str, ssid: str, password: str) -> None:
    if profile not in PROFILES:
        raise NetError("profile must be magso or router")
    s = ssid or ""
    if not s.strip() or len(s.encode()) > 32 or any(ord(c) < 32 for c in s):
        raise NetError("the network name (SSID) must be 1 to 32 characters")
    if password and (not 8 <= len(password) <= 63 or any(ord(c) < 32 or ord(c) > 126 for c in password)):
        raise NetError("a Wi-Fi password is 8 to 63 ordinary characters (leave it empty for an open network)")


class HelperNetwork:
    """Calls the root helper on the Pi."""

    def __init__(self, helper: str = HELPER):
        self.helper = helper

    def _run(self, *args: str, payload: dict | None = None, timeout: float = 60) -> Any:
        try:
            p = subprocess.run(["sudo", "-n", self.helper, *args], input=json.dumps(payload or {}),
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise NetError("the network helper took too long")
        if p.returncode != 0:
            msg = (p.stderr or p.stdout).strip().splitlines()
            raise NetError(msg[-1] if msg else f"network helper failed ({p.returncode})")
        try:
            return json.loads(p.stdout or "null")
        except ValueError:
            raise NetError("the network helper returned something unexpected")

    def status(self):
        return self._run("status", timeout=20)

    def scan(self):
        return self._run("scan", timeout=30)

    def set_wifi(self, profile, ssid, password):
        validate(profile, ssid, password)
        return self._run("set", profile, payload={"ssid": ssid, "password": password}, timeout=75)

    def forget(self, profile):
        if profile not in PROFILES:
            raise NetError("profile must be magso or router")
        return self._run("forget", profile)

    def hotspot(self):
        return self._run("hotspot", timeout=45)


class SimNetwork:
    """Stand-in for development and tests. Remembers changes in memory only."""

    def __init__(self, mode: str = "dev"):
        self._lock = threading.Lock()
        self._mode = mode
        self._profiles: dict[str, str | None] = {"magso": None, "router": "GreenhouseNet"}
        self._ssid = "GreenhouseNet"

    def status(self):
        with self._lock:
            return {"mode": self._mode, "simulated": True,
                    "wifi": {"ssid": self._ssid, "signal": 72, "profile": "router" if self._ssid == "GreenhouseNet" else "magso"},
                    "addresses": {"wlan0": "192.168.50.10/24"}, "gateway": "192.168.50.1", "internet": True,
                    "hotspot": {"ssid": "SmartGreenhouse", "address": "10.42.0.1"},
                    "profiles": dict(self._profiles), "hostname": "greenhouse"}

    def scan(self):
        return [{"ssid": "GreenhouseNet", "signal": 72, "security": "WPA2", "in_use": self._ssid == "GreenhouseNet"},
                {"ssid": "MAgSO-Office", "signal": 58, "security": "WPA2", "in_use": self._ssid == "MAgSO-Office"},
                {"ssid": "LGU-TomasOppus", "signal": 41, "security": "WPA2", "in_use": False},
                {"ssid": "PLDTHOMEFIBR_5G", "signal": 23, "security": "WPA2 WPA3", "in_use": False}]

    def set_wifi(self, profile, ssid, password):
        validate(profile, ssid, password)
        with self._lock:
            self._profiles[profile] = ssid
            self._ssid = ssid
            self._mode = profile
        return {"ok": True, "connected": True, "message": f"Saved as {PROFILE_LABEL[profile]} and connected to {ssid} (simulated)."}

    def forget(self, profile):
        with self._lock:
            self._profiles[profile] = None
        return {"ok": True, "message": f"{PROFILE_LABEL[profile]} removed (simulated)."}

    def hotspot(self):
        with self._lock:
            self._mode, self._ssid = "hotspot", "SmartGreenhouse"
        return {"ok": True, "message": "Hotspot SmartGreenhouse started (simulated). The controller is at 10.42.0.1."}


def make_network(hal: str) -> Network:
    """The real helper on the Pi when it is installed; otherwise the stand-in."""
    if hal == "pi" and os.path.exists(HELPER) and shutil.which("sudo"):
        return HelperNetwork()
    return SimNetwork()
