"""Message bus: MQTT in production, an in-memory bus for tests and the all-in-one dev mode."""
from __future__ import annotations

import json
import logging
import threading
from collections import defaultdict
from typing import Any, Callable

from paho.mqtt.client import topic_matches_sub

log = logging.getLogger(__name__)

Handler = Callable[[str, dict[str, Any]], None]


class Topics:
    def __init__(self, gh: str):
        self.gh = gh
        self.base = f"gh/{gh}"

    def node_raw(self, node: str = "+") -> str:
        return f"{self.base}/node/{node}/raw"

    def node_status(self, node: str = "+") -> str:
        return f"{self.base}/node/{node}/status"

    def reading(self, zone: int | str = "+", sensor: str = "+") -> str:
        return f"{self.base}/zone/{zone}/sensor/{sensor}"

    def actuator_state(self, aid: str = "+") -> str:
        return f"{self.base}/actuator/{aid}/state"

    def cmd(self, aid: str = "+") -> str:
        return f"{self.base}/actuator/{aid}/cmd"

    def ack(self, aid: str = "+") -> str:
        return f"{self.base}/actuator/{aid}/ack"

    @property
    def alert(self) -> str:
        return f"{self.base}/alert"

    @property
    def status(self) -> str:
        return f"{self.base}/status"

    @property
    def config_changed(self) -> str:
        return f"{self.base}/config/changed"

    @staticmethod
    def segment(topic: str, index: int) -> str:
        return topic.split("/")[index]


class Bus:
    def publish(self, topic: str, payload: dict[str, Any], retain: bool = False, qos: int = 0) -> None:
        raise NotImplementedError

    def subscribe(self, pattern: str, handler: Handler, qos: int = 0) -> None:
        raise NotImplementedError

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


class MemoryBus(Bus):
    """Synchronous in-process bus with retained messages. Handlers run on the publisher's thread."""

    def __init__(self) -> None:
        self._subs: list[tuple[str, Handler]] = []
        self._retained: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self.published: list[tuple[str, dict[str, Any]]] = []

    def publish(self, topic: str, payload: dict[str, Any], retain: bool = False, qos: int = 0) -> None:
        payload = json.loads(json.dumps(payload))  # same serialisation constraints as MQTT
        with self._lock:
            self.published.append((topic, payload))
            if len(self.published) > 5000:
                del self.published[:1000]
            if retain:
                self._retained[topic] = payload
            subs = list(self._subs)
        for pattern, h in subs:
            if topic_matches_sub(pattern, topic):
                try:
                    h(topic, payload)
                except Exception:  # pragma: no cover - logged, never kills the publisher
                    log.exception("handler for %s failed", pattern)

    def subscribe(self, pattern: str, handler: Handler, qos: int = 0) -> None:
        with self._lock:
            self._subs.append((pattern, handler))
            retained = [(t, p) for t, p in self._retained.items() if topic_matches_sub(pattern, t)]
        for t, p in retained:
            handler(t, p)

    def retained(self, topic: str) -> dict[str, Any] | None:
        return self._retained.get(topic)


class MqttBus(Bus):
    """paho-mqtt wrapper. Re-subscribes after reconnects; handlers run on paho's network thread."""

    def __init__(self, host: str, port: int, client_id: str, username: str | None = None,
                 password: str | None = None, will: tuple[str, dict[str, Any]] | None = None):
        import paho.mqtt.client as mqtt

        self._mqtt = mqtt
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=True)
        if username:
            self.client.username_pw_set(username, password)
        if will:
            self.client.will_set(will[0], json.dumps(will[1]), qos=1, retain=True)
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.host, self.port = host, port
        self._subs: list[tuple[str, Handler, int]] = []
        self._lock = threading.Lock()
        self.connected = threading.Event()
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if getattr(reason_code, "is_failure", False):
            log.error("MQTT connect failed: %s", reason_code)
            return
        log.info("MQTT connected to %s:%s", self.host, self.port)
        with self._lock:
            subs = list(self._subs)
        for pattern, _, qos in subs:
            client.subscribe(pattern, qos=qos)
        self.connected.set()

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected.clear()
        log.warning("MQTT disconnected (%s); paho will reconnect", reason_code)

    def _on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8")) if msg.payload else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("dropping non-JSON message on %s", msg.topic)
            return
        with self._lock:
            subs = list(self._subs)
        for pattern, h, _ in subs:
            if topic_matches_sub(pattern, msg.topic):
                try:
                    h(msg.topic, payload)
                except Exception:
                    log.exception("handler for %s failed", pattern)

    def publish(self, topic: str, payload: dict[str, Any], retain: bool = False, qos: int = 0) -> None:
        self.client.publish(topic, json.dumps(payload), qos=qos, retain=retain)

    def subscribe(self, pattern: str, handler: Handler, qos: int = 0) -> None:
        with self._lock:
            self._subs.append((pattern, handler, qos))
        if self.connected.is_set():
            self.client.subscribe(pattern, qos=qos)

    def start(self, wait_s: float = 10.0) -> None:
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_start()
        if not self.connected.wait(wait_s):
            log.warning("MQTT broker %s:%s not reachable yet; continuing and retrying in the background",
                        self.host, self.port)

    def stop(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


_shared: dict[str, MemoryBus] = defaultdict(MemoryBus)


def make_bus(settings, client_id: str, will: tuple[str, dict[str, Any]] | None = None) -> Bus:
    if settings.mqtt_host == "memory":
        return _shared["default"]
    return MqttBus(settings.mqtt_host, settings.mqtt_port, client_id, settings.mqtt_username,
                   settings.mqtt_password, will=will)
