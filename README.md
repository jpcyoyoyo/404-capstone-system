# 404-capstone-system

Production code for the capstone **"Implementation of a Multi-Parameter Threshold-Based Control
Algorithm in an IoT-Enabled Smart Greenhouse System"** by **404 Brains Not Found**, for the
Municipal Agriculture Services Office (MAgSO), Tomas Oppus, Southern Leyte.

A Raspberry Pi 5 reads the greenhouse sensors (two ESP sensing nodes over Wi-Fi/MQTT plus its own
reservoir sensors), runs the threshold-based control algorithm, drives irrigation, lighting and
fertigation, and serves an Ionic React app (Android, browser, and a read-only wall display). This
repository replaces the earlier demo app (`404-capstone-app-demo`), whose simulation lives on here
as the app's labelled **Demo** mode.

```
contract/     what the app, the Pi and the nodes agree on: registry.yaml (zones, sensors, actuators,
              pins, thresholds), JSON schemas, MQTT topics. Change it here first.
controller/   Raspberry Pi 5 software (Python 3.11): sensors, control loop, REST API, cloud sync,
              hardware layer (simulated or real GPIO), bench checks (`greenhouse hw …`), tests.
app/          Ionic React + Capacitor app (Android APK, browser, and the /kiosk wall display).
firmware/     Arduino sketch for the ESP8266 (Node A) and ESP32 (Node B) sensing nodes.
deploy/       Pi setup script, systemd units, Mosquitto, MySQL 8, network fallback, kiosk, cloud.
.github/      CI: controller tests, app lint/type-check/tests/build, contract sync check.
```

**Build and install on real hardware:** follow *Component Assembly Procedures, Rev. 2* (in the
team's project documents). Section P replaces the demo on the Pi with this repository; Sections
A–E assemble and validate each sensor and actuator with `sudo ghctl hw …`.

**Team:** Lovely S. Dikit · Hannah Mae C. Lopez · John Paul B. Cadavez · Bryana Rose R. Canon —
Adviser: Felanie V. Docena, MSIT.

## What works now, and what waits for the hardware

| Part | State |
| --- | --- |
| Control algorithm (medians per zone, quality flags, interlocks, arbitration, hysteresis, min on/off, max run, daily cap, manual override, ESTOP) | Done, 24 control tests incl. the 10 Gate-2 fault injections |
| REST API, auth (admin/viewer, refresh tokens), commands with ack and expiry, thresholds, alerts, history, reports, calibration, users | Done, tested in-process and against a real Mosquitto |
| MQTT (1883 services/nodes, 9001 WebSocket for the app, read-only app account) | Done |
| MySQL 8 schema, retention roll-up, nightly backup, cloud sync | Done (`deploy/mysql/schema.sql` is the reference copy) |
| App: live mode (REST + MQTT), demo mode (SIMULATED acks), offline last-known values, all screens wired | Done |
| Kiosk page `/kiosk` and Chromium kiosk launcher | Done |
| Network fallback: MAgSO Wi-Fi › dedicated router › Pi hotspot | Done (scripts; test on the Pi) |
| Real hardware drivers `controller/greenhouse/hal/pi.py` | Written, **not yet run on hardware** |
| Pin map in `contract/registry.yaml` | Proposed resolutions in place (lines marked `CONFLICT`); confirm on the bench per Component Assembly Procedures Rev. 2 |
| Bench checks `greenhouse hw …` (`sudo ghctl hw …` on the Pi) | Done, used by the assembly procedures |
| ESP8266/ESP32 node firmware (`firmware/greenhouse_node`, one sketch for both nodes) | Written and checked against the library headers; **not yet flashed to the boards** (see `firmware/README.md`) |
| Solar/energy screen | Kept but hidden (`capabilities.energy: false`) — outside the study scope |

Until the pin map is settled, everything runs on the simulator (`GH_HAL=sim`), which uses the same
code paths as the real drivers.

## Run it on a PC (no hardware)

Python 3.11+ and Node 22.

```bash
# controller: API + sensors + control + simulated nodes in one process, SQLite, in-memory MQTT
python -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e "controller[dev]"
cd controller && greenhouse dev --cycle 10            # http://localhost:8000/docs

# app (second terminal)
cd app && npm ci && npm run dev                        # http://localhost:5173
```

Sign in with **admin@greenhouse.local / greenhouse**. The app finds the controller at
`http://<this host>:8000` by default; change it under App Settings → Connection. Without a broker
the app polls every 5 s; with Mosquitto running and `GH_MQTT_HOST`, `GH_MQTT_WS_URL=ws://auto:9001`
and the app account set, it streams live.

To try the fault cases from the app, call `POST /sim/fault` (enable with `GH_ENABLE_SIM_API=1`),
e.g. `{"kind": "drain"}` for low water or `{"kind": "node_offline", "node_id": "node_b"}`.

**Demo mode** (sign-in screen → Demo) needs no controller at all. Every command answers
`SIMULATED` and the whole app is labelled DEMO MODE — this is the defence fallback.

## Tests

```bash
cd controller && pytest -q          # 44 tests: control loop, Gate-2 faults, API, sync, contract
cd app && npm run lint && npx tsc --noEmit && npm run test.unit && npm run build
python contract/tools/gen_ts.py     # must leave app/src/contract/registry.generated.ts unchanged
```

GitHub Actions runs all of these on every push and pull request (`.github/workflows/ci.yml`).

## Install on the Raspberry Pi

1. Get this repository onto the Pi (Raspberry Pi OS Bookworm 64-bit with desktop):
   `git clone <repo-url> ~/404-capstone-system`, then `cd ~/404-capstone-system/app && npm ci && npm run build`.
2. Replacing the demo on a Pi that already runs it: Component Assembly Procedures Rev. 2, Section P.
3. `sudo ./deploy/pi-setup.sh` — or `sudo ./deploy/pi-setup.sh --sim` on the bench without sensors.
   It installs Mosquitto, MySQL 8 (Docker), the Python venv, secrets, the database, the first
   administrator, the systemd services and the kiosk autostart.
4. Networks: edit `/etc/greenhouse/network.conf`, then
   `sudo /opt/greenhouse/deploy/network/setup-network.sh && sudo systemctl enable --now greenhouse-net`.

| Network | Pi address in the app |
| --- | --- |
| MAgSO Wi-Fi | `http://greenhouse.local:8000` (or the DHCP address; ask IT to reserve it) |
| Dedicated router | `http://192.168.50.10:8000` |
| Pi hotspot `SmartGreenhouse` | `http://10.42.0.1:8000` |

The app tries every saved address in order, so all three can be saved at once
(App Settings → Connection).

Services: `greenhouse-sensors`, `greenhouse-control`, `greenhouse-api`, `greenhouse-sync`
(only with a cloud URL), `greenhouse-db` (MySQL), `greenhouse-net`, plus `greenhouse-simnodes`
for bench tests. Logs: `journalctl -u greenhouse-control -f`.

Node MQTT passwords are in `/etc/greenhouse/node-credentials.txt`.

## Kiosk

The Pi's screen shows `http://localhost:8000/kiosk` in Chromium kiosk mode
(`deploy/kiosk/kiosk.sh`, started from the desktop autostart). It is read-only and needs no
sign-in: the API only issues the display token to requests from the Pi itself, or to anyone with
`GH_KIOSK_TOKEN` (`/kiosk?token=…`), so a laptop or TV on the network can show it too.
`/kiosk?demo=1` shows the simulation.

## Cloud replica (remote viewing)

`deploy/cloud/`: MySQL, the API with `GH_ROLE=cloud`, and Caddy for HTTPS. Set the same
`GH_JWT_SECRET` as the Pi, a shared `GH_SYNC_TOKEN`, then on the Pi set `GH_CLOUD_URL` and
`GH_SYNC_TOKEN` and enable `greenhouse-sync`. The app falls back to the cloud address when the
Pi is not reachable; controls stay disabled there while `remote_commands` is false.

## Android app

```bash
cd app && npm run build
npx cap add android          # first time only: android/ is generated, not committed
npx cap sync android && npx cap open android
```

Build the APK in Android Studio (details in `app/README.md`). Cleartext HTTP is allowed (`server.cleartext` in `capacitor.config.ts`) because
the Pi serves plain HTTP on the local network.

## When the hardware is reconciled

1. Update pins and `installed:` flags in `contract/registry.yaml` (remove the `CONFLICT` notes).
2. `cd controller && pytest -q` — the contract tests catch shared relay channels, missing valves,
   unknown sensor types.
3. `python contract/tools/gen_ts.py` to refresh `app/src/contract/registry.generated.ts`, then rebuild the app.
4. On the Pi: set `GH_HAL=pi` in `/etc/greenhouse/greenhouse.env`, re-run `pi-setup.sh`, and run
   the Gate 1 / Gate 2 checklists with each device.
