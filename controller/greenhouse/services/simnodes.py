"""Simulated Node A and Node B: publish raw readings exactly as the ESP firmware will.

Lets the app and the controller run end to end before the real nodes are on MQTT.
Listens on gh/{gh}/sim/fault for fault injection (dev only).
"""
from __future__ import annotations

import logging
import threading

from ..bus import Bus, Topics
from ..hal.sim import Environment
from ..registry import Registry
from ..timeutil import iso, utcnow

log = logging.getLogger(__name__)


class SimNodes:
    def __init__(self, reg: Registry, bus: Bus, env: Environment, interval_s: float = 30.0):
        self.reg, self.bus, self.env, self.interval_s = reg, bus, env, interval_s
        self.topics = Topics(reg.greenhouse_id)
        self._stop = threading.Event()
        self._seq = 0
        self._online: dict[str, bool] = {}

    def start(self) -> None:
        self.bus.subscribe(self.topics.actuator_state(), self._on_actuator)
        self.bus.subscribe(f"{self.topics.base}/sim/fault", self._on_fault)
        threading.Thread(target=self._loop, name="sim-nodes", daemon=True).start()
        log.info("simulated nodes publishing every %.0f s", self.interval_s)

    def stop(self) -> None:
        self._stop.set()

    def _on_actuator(self, topic: str, p: dict) -> None:
        aid = p.get("actuator_id")
        if aid and aid != "irrigation":
            self.env.set_actuator(aid, bool(p.get("on")))

    def _on_fault(self, topic: str, p: dict) -> None:
        log.warning("sim fault: %s → %s", p, self.env.apply_fault(p))
        self.publish_once()

    def publish_once(self) -> None:
        self.env.step()
        now = utcnow()
        for node in self.reg.nodes:
            online = node.id not in self.env.offline_nodes
            if self._online.get(node.id) != online:
                # What the broker does with the node's last will when it drops off.
                self.bus.publish(self.topics.node_status(node.id), {"online": online, "ts": iso(now)}, retain=True, qos=1)
                self._online[node.id] = online
            if not online:
                continue
            readings = []
            for sd in self.reg.node_sensors(node.id):
                if not sd.installed:
                    continue
                s = self.env.sample(sd, now)
                if s is None:
                    continue
                readings.append({"sensor_id": s.sensor_id, "raw": s.raw, "ok": s.ok, **({"error": s.error} if s.error else {})})
            self._seq += 1
            self.bus.publish(self.topics.node_raw(node.id), {"node_id": node.id, "ts": iso(now), "seq": self._seq,
                                                              "readings": readings})

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.publish_once()
            except Exception:
                log.exception("sim node publish failed")
            self._stop.wait(self.interval_s)
