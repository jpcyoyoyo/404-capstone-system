"""Generates app/src/contract/registry.generated.ts from contract/registry.yaml.

Run after every registry change:  python contract/tools/gen_ts.py
(The demo mode and offline fallback in the app read this; live mode reads /greenhouse from the Pi.)
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
data = yaml.safe_load((ROOT / "contract" / "registry.yaml").read_text(encoding="utf-8"))
units = data.get("sensor_defaults", {}).get("units", {})

meta = {
    "id": data["greenhouse"]["id"],
    "name": data["greenhouse"]["name"],
    "timezone": data["greenhouse"].get("timezone", "Asia/Manila"),
    "capabilities": data.get("capabilities", {}),
    "zones": data["zones"],
    "nodes": [{"id": n["id"], "board": n["board"], "zone": n["zone"]} for n in data.get("nodes", [])],
    "stages": data["growth_stages"],
    "sensors": [{"id": s["id"], "type": s["type"], "zone": s["zone"], "host": s["host"],
                 "unit": units.get(s["type"], ""), "installed": s.get("installed", True),
                 "calibration": s.get("calibration", "none")} for s in data["sensors"]],
    "actuators": [{"id": a["id"], "name": a["name"], "group": a["group"], "kind": a["kind"],
                   "installed": a.get("installed", True), "water": a.get("water", False),
                   "manual_only": a.get("manual_only", False), "virtual": False, "circuit": a.get("circuit")}
                  for a in data["actuators"]]
                 + [{"id": v["id"], "name": v["name"], "group": v["group"], "kind": "virtual", "installed": True,
                     "water": v.get("water", False), "manual_only": False, "virtual": True, "circuit": None}
                    for v in data.get("virtual_actuators", [])],
    "control": {"cycle_s": data["control"].get("cycle_s", 30),
                "command_expiry_s": data["control"].get("command_expiry_s", 60),
                "manual_override_max_s": data["control"].get("manual_override_max_s", 1800),
                "photoperiod": data["control"].get("photoperiod")},
}
thresholds = {}
for st in data["growth_stages"]:
    thresholds[st["id"]] = [{"parameter": p, "min": v["min"], "max": v["max"],
                             "deadband": data["thresholds"]["deadbands"].get(p, 0), "unit": units.get(p, "")}
                            for p, v in data["thresholds"][st["id"]].items()]

out = ROOT / "app" / "src" / "contract" / "registry.generated.ts"
out.write_text(
    "// GENERATED from contract/registry.yaml by contract/tools/gen_ts.py — do not edit by hand.\n"
    "import type { GreenhouseMeta, Threshold } from './types';\n\n"
    f"export const REGISTRY_META: GreenhouseMeta = {json.dumps(meta, indent=2, ensure_ascii=False)} as GreenhouseMeta;\n\n"
    f"export const DEFAULT_THRESHOLDS: Record<string, Threshold[]> = {json.dumps(thresholds, indent=2, ensure_ascii=False)};\n",
    encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)}")
