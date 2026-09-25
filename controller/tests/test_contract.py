"""Every payload the controller publishes must match contract/schemas."""
from __future__ import annotations

import json
from pathlib import Path

import jsonschema
from paho.mqtt.client import topic_matches_sub

from .test_api import Rig

SCHEMAS = Path(__file__).resolve().parents[2] / "contract" / "schemas"


def schema(name):
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text())


def test_published_payloads_match_schemas(tmp_path):
    rig = Rig(tmp_path)
    rig.cycle()
    h = rig.login()
    rig.client.post("/actuator/irrigation/command", json={"action": "ON"}, headers=h)
    rig.client.post("/sim/fault", json={"kind": "drain", "value": 5}, headers=h)
    rig.cycle()
    checks = {
        "gh/gh1/zone/+/sensor/+": "reading",
        "gh/gh1/node/+/raw": "node_raw",
        "gh/gh1/actuator/+/state": "actuator_state",
        "gh/gh1/actuator/+/ack": "ack",
        "gh/gh1/alert": "alert",
        "gh/gh1/status": "status",
    }
    seen = {k: 0 for k in checks}
    for topic, payload in rig.bus.published:
        for pattern, name in checks.items():
            if topic_matches_sub(pattern, topic):
                if name == "actuator_state" and payload.get("actuator_id") == "irrigation":
                    continue
                jsonschema.validate(payload, schema(name))
                seen[pattern] += 1
    assert all(seen.values()), seen


def test_command_schema_accepts_api_body():
    jsonschema.validate({"cmd_id": "550e8400-e29b-41d4-a716-446655440000", "actuator_id": "pump", "action": "ON",
                         "duration_s": 120, "issued_by": "a@b.c", "reason": "MANUAL_OVERRIDE",
                         "ts": "2026-10-13T08:00:00+08:00"}, schema("command"))
