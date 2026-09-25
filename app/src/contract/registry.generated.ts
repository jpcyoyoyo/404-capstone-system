// GENERATED from contract/registry.yaml by contract/tools/gen_ts.py — do not edit by hand.
import type { GreenhouseMeta, Threshold } from './types';

export const REGISTRY_META: GreenhouseMeta = {
  "id": "gh1",
  "name": "MAgSO Smart Greenhouse",
  "timezone": "Asia/Manila",
  "capabilities": {
    "energy": false,
    "push": false,
    "remote_commands": false
  },
  "zones": [
    {
      "id": 0,
      "name": "Reservoir & controller",
      "description": "Shared sensors at the controller and fertigation reservoir"
    },
    {
      "id": 1,
      "name": "Zone 1",
      "description": "Node A (ESP8266)"
    },
    {
      "id": 2,
      "name": "Zone 2",
      "description": "Node B (ESP32)"
    }
  ],
  "nodes": [
    {
      "id": "node_a",
      "board": "esp8266",
      "zone": 1
    },
    {
      "id": "node_b",
      "board": "esp32",
      "zone": 2
    }
  ],
  "stages": [
    {
      "id": "seedling",
      "name": "Seedling",
      "sequence": 1,
      "irrigation_mode": "fog",
      "description": "Fogging/misting, high humidity"
    },
    {
      "id": "growth",
      "name": "Growth",
      "sequence": 2,
      "irrigation_mode": "drip",
      "description": "Balanced drip irrigation"
    },
    {
      "id": "mature",
      "name": "Mature",
      "sequence": 3,
      "irrigation_mode": "sprinkler",
      "description": "Pressurised sprinklers"
    }
  ],
  "sensors": [
    {
      "id": "temp_z1_01",
      "type": "temperature",
      "zone": 1,
      "host": "node_a",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z1_01",
      "type": "humidity",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "temp_z1_02",
      "type": "temperature",
      "zone": 1,
      "host": "node_a",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z1_02",
      "type": "humidity",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "temp_z1_03",
      "type": "temperature",
      "zone": 1,
      "host": "node_a",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z1_03",
      "type": "humidity",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "soil_z1_01",
      "type": "soil_moisture",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "soil_z1_02",
      "type": "soil_moisture",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "soil_z1_03",
      "type": "soil_moisture",
      "zone": 1,
      "host": "node_a",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "light_z1_01",
      "type": "light",
      "zone": 1,
      "host": "node_a",
      "unit": "lux",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "temp_z2_01",
      "type": "temperature",
      "zone": 2,
      "host": "node_b",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z2_01",
      "type": "humidity",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "temp_z2_02",
      "type": "temperature",
      "zone": 2,
      "host": "node_b",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z2_02",
      "type": "humidity",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "temp_z2_03",
      "type": "temperature",
      "zone": 2,
      "host": "node_b",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "hum_z2_03",
      "type": "humidity",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "soil_z2_01",
      "type": "soil_moisture",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "soil_z2_02",
      "type": "soil_moisture",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "soil_z2_03",
      "type": "soil_moisture",
      "zone": 2,
      "host": "node_b",
      "unit": "%",
      "installed": true,
      "calibration": "dry_wet"
    },
    {
      "id": "light_z2_01",
      "type": "light",
      "zone": 2,
      "host": "node_b",
      "unit": "lux",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "co2_01",
      "type": "co2",
      "zone": 0,
      "host": "pi",
      "unit": "ppm",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "ph_01",
      "type": "ph",
      "zone": 0,
      "host": "pi",
      "unit": "pH",
      "installed": true,
      "calibration": "two_point"
    },
    {
      "id": "ec_01",
      "type": "ec",
      "zone": 0,
      "host": "pi",
      "unit": "mS/cm",
      "installed": false,
      "calibration": "two_point"
    },
    {
      "id": "wtemp_01",
      "type": "water_temperature",
      "zone": 0,
      "host": "pi",
      "unit": "°C",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "level_01",
      "type": "water_level",
      "zone": 0,
      "host": "pi",
      "unit": "%",
      "installed": true,
      "calibration": "none"
    },
    {
      "id": "flow_01",
      "type": "water_flow",
      "zone": 0,
      "host": "pi",
      "unit": "L/min",
      "installed": false,
      "calibration": "none"
    },
    {
      "id": "hopper_01",
      "type": "hopper_weight",
      "zone": 0,
      "host": "pi",
      "unit": "g",
      "installed": true,
      "calibration": "scale"
    },
    {
      "id": "float_01",
      "type": "float_switch",
      "zone": 0,
      "host": "pi",
      "unit": "state",
      "installed": true,
      "calibration": "none"
    }
  ],
  "actuators": [
    {
      "id": "pump",
      "name": "Pressure washer",
      "group": "irrigation",
      "kind": "relay",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "valve_fog",
      "name": "Fogging valve",
      "group": "irrigation",
      "kind": "relay",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": false,
      "circuit": "fog"
    },
    {
      "id": "valve_drip",
      "name": "Drip valve",
      "group": "irrigation",
      "kind": "relay",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": false,
      "circuit": "drip"
    },
    {
      "id": "valve_sprinkler",
      "name": "Sprinkler valve",
      "group": "irrigation",
      "kind": "relay",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": false,
      "circuit": "sprinkler"
    },
    {
      "id": "servo_main",
      "name": "Main ball valve",
      "group": "irrigation",
      "kind": "servo",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "servo_diverter",
      "name": "Diverter ball valve",
      "group": "irrigation",
      "kind": "servo",
      "installed": true,
      "water": true,
      "manual_only": true,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "fan_exhaust",
      "name": "Exhaust fan",
      "group": "climate",
      "kind": "relay",
      "installed": false,
      "water": false,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "lights",
      "name": "Grow lights",
      "group": "climate",
      "kind": "ssr",
      "installed": true,
      "water": false,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "auger",
      "name": "Fertilizer auger",
      "group": "fertigation",
      "kind": "stepper",
      "installed": true,
      "water": false,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "fan_enclosure",
      "name": "Enclosure fans",
      "group": "enclosure",
      "kind": "relay",
      "installed": false,
      "water": false,
      "manual_only": false,
      "virtual": false,
      "circuit": null
    },
    {
      "id": "irrigation",
      "name": "Irrigation",
      "group": "irrigation",
      "kind": "virtual",
      "installed": true,
      "water": true,
      "manual_only": false,
      "virtual": true,
      "circuit": null
    }
  ],
  "control": {
    "cycle_s": 30,
    "command_expiry_s": 60,
    "manual_override_max_s": 1800,
    "photoperiod": {
      "start": "06:00",
      "end": "18:00"
    }
  }
} as GreenhouseMeta;

export const DEFAULT_THRESHOLDS: Record<string, Threshold[]> = {
  "seedling": [
    {
      "parameter": "soil_moisture",
      "min": 70,
      "max": 80,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "temperature",
      "min": 22,
      "max": 28,
      "deadband": 1.5,
      "unit": "°C"
    },
    {
      "parameter": "humidity",
      "min": 70,
      "max": 85,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "light",
      "min": 8000,
      "max": 40000,
      "deadband": 1000,
      "unit": "lux"
    },
    {
      "parameter": "co2",
      "min": 400,
      "max": 800,
      "deadband": 50,
      "unit": "ppm"
    },
    {
      "parameter": "ph",
      "min": 5.8,
      "max": 6.2,
      "deadband": 0.2,
      "unit": "pH"
    },
    {
      "parameter": "ec",
      "min": 0.8,
      "max": 1.2,
      "deadband": 0.2,
      "unit": "mS/cm"
    }
  ],
  "growth": [
    {
      "parameter": "soil_moisture",
      "min": 60,
      "max": 75,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "temperature",
      "min": 20,
      "max": 30,
      "deadband": 1.5,
      "unit": "°C"
    },
    {
      "parameter": "humidity",
      "min": 60,
      "max": 80,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "light",
      "min": 12000,
      "max": 40000,
      "deadband": 1000,
      "unit": "lux"
    },
    {
      "parameter": "co2",
      "min": 400,
      "max": 1000,
      "deadband": 50,
      "unit": "ppm"
    },
    {
      "parameter": "ph",
      "min": 5.5,
      "max": 6.5,
      "deadband": 0.2,
      "unit": "pH"
    },
    {
      "parameter": "ec",
      "min": 1.2,
      "max": 1.8,
      "deadband": 0.2,
      "unit": "mS/cm"
    }
  ],
  "mature": [
    {
      "parameter": "soil_moisture",
      "min": 55,
      "max": 70,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "temperature",
      "min": 20,
      "max": 32,
      "deadband": 1.5,
      "unit": "°C"
    },
    {
      "parameter": "humidity",
      "min": 55,
      "max": 75,
      "deadband": 5,
      "unit": "%"
    },
    {
      "parameter": "light",
      "min": 15000,
      "max": 40000,
      "deadband": 1000,
      "unit": "lux"
    },
    {
      "parameter": "co2",
      "min": 400,
      "max": 1000,
      "deadband": 50,
      "unit": "ppm"
    },
    {
      "parameter": "ph",
      "min": 5.5,
      "max": 6.5,
      "deadband": 0.2,
      "unit": "pH"
    },
    {
      "parameter": "ec",
      "min": 1.5,
      "max": 2.0,
      "deadband": 0.2,
      "unit": "mS/cm"
    }
  ]
};
