# Contract

Everything the app, the Pi and the nodes agree on. Change it here first; the
controller's tests and the app's types are checked against it.

| File | What it defines |
| --- | --- |
| `registry.yaml` | Zones, nodes, growth stages, default thresholds, every sensor and actuator with its pin or channel, and which parts are installed |
| `schemas/*.schema.json` | JSON payloads on MQTT and the REST API |

The app mirrors these shapes in `app/src/contract/types.ts`; the controller in
`controller/greenhouse/contract.py`.

## MQTT topics

`{gh}` is `greenhouse.id` from the registry (`gh1`).

| Topic | Payload | QoS / retained | Publisher |
| --- | --- | --- | --- |
| `gh/{gh}/node/{node_id}/raw` | `node_raw` | 0 | Sensing nodes |
| `gh/{gh}/node/{node_id}/status` | `{"online": bool}` (last will = false) | 1, retained | Sensing nodes |
| `gh/{gh}/zone/{zone}/sensor/{sensor_id}` | `reading` | 0, retained | `greenhouse-sensors` |
| `gh/{gh}/actuator/{id}/state` | `actuator_state` | 1, retained | `greenhouse-control` |
| `gh/{gh}/actuator/{id}/cmd` | `command` | 1 | `greenhouse-api` |
| `gh/{gh}/actuator/{id}/ack` | `ack` | 1 | `greenhouse-control` |
| `gh/{gh}/alert` | `alert` | 1 | `greenhouse-control`, `greenhouse-sensors` |
| `gh/{gh}/status` | `status` (last will `{"online": false}`) | 1, retained | `greenhouse-control` |
| `gh/{gh}/config/changed` | `{"what": "thresholds" \| "stage", "ts": ...}` | 1 | `greenhouse-api` |

One deviation from Integration Plan §8.2: readings are published per sensor
(`.../sensor/{sensor_id}`), not per type, because each zone has three sensors of
the same type. The type is inside the payload.

Nodes publish raw values only. The Pi applies calibration constants from the
database and sets the quality flag, so a recalibration never needs a firmware
update.

## Commands

The app never publishes commands to MQTT. It calls `POST /actuator/{id}/command`;
the API records the command, publishes it on `.../cmd`, and waits up to
`ack_timeout` for the controller's ack. The `commands` table row is the single
arbiter: the controller only executes a command if it can move the row from
`PENDING` to `ACCEPTED`, and the API only reports a timeout if it can move it to
`EXPIRED`. A command can therefore never run after the app was told it expired.

Stopping a dose: send `OFF` to `auger` while it doses; the dose ends as `aborted` with reason
`STOPPED`. `ESTOP` (to `/actuator/all/command`) also stops a running dose and raises an `ESTOP`
event alert. Event alerts close when acknowledged; condition alerts close when the condition clears.

Ack statuses: `ACCEPTED`, `REJECTED` (with a reason such as `LOW_WATER`,
`MIN_OFF_TIME`, `PUMP_BUSY`, `NOT_INSTALLED`), `EXPIRED`, and `SIMULATED` (demo
mode only — nothing physical moved).

## Quality flags

`VALID`, `WARMING` (e.g. CO₂ in its first 3 minutes), `STALE` (no reading for 3
cycles or node offline), `INVALID` (implausible or failed read), `UNCALIBRATED`
(needs calibration constants that are not recorded yet). Only `VALID` readings
feed the control loop. A failed read is published with `value: null`, never 0.
