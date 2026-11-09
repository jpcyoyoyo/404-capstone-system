# Sensing-node firmware

One Arduino sketch for both nodes (`greenhouse_node/`). `NODE_ID` in `config.h` selects the board
wiring and the sensor IDs, which must match `contract/registry.yaml`.

| | Node A | Node B |
| --- | --- | --- |
| Board (Arduino IDE) | NodeMCU 1.0 (ESP-12E Module), ESP8266 core 3.x | ESP32 Dev Module, ESP32 core 3.x |
| I²C | SDA D2 (GPIO4), SCL D1 (GPIO5) | SDA GPIO21, SCL GPIO22 |
| DHT22 ×3 | D5, D6, D7 (GPIO14, 12, 13) | GPIO25, 26, 27 |
| BH1750 | 0x23 (ADDR to GND or open) | 0x5C (ADDR to 3.3 V) |
| ADS1115 (soil) | 0x48, A0–A2 | 0x48, A0–A2 |

Libraries (Library Manager): **DHT sensor library** (Adafruit) + Adafruit Unified Sensor,
**BH1750** (Christopher Laws), **Adafruit ADS1X15**, **PubSubClient** (Nick O'Leary),
**ArduinoJson** 7.x.

1. Copy `config.example.h` to `config.h` (or `config_a.h` / `config_b.h`) and fill in Wi-Fi, the Pi's
   address, the node's MQTT password (`sudo cat /etc/greenhouse/node-credentials.txt` on the Pi) and
   `OTA_PASS` (see Wireless debugging).
2. Select the board, upload, and open the Serial Monitor at 115200 baud.
3. On the Pi: `sudo ghctl hw watch --node node_a`.

The node publishes raw values only (DHT22 °C and %RH, BH1750 lux, ADS1115 counts at ±4.096 V).
A failed read is sent as `"raw": null, "ok": false` with an error code, never as 0.
Status is retained on `gh/gh1/node/<id>/status` with a last will of `{"online": false}`.

## Wireless debugging (no USB cable)

With `OTA_PASS` in the node's config file (8 characters or more), the node also offers:

- **Network log**: everything it prints to the Serial Monitor, on TCP port 23, after the password.
- **OTA uploads**: new firmware over Wi-Fi from the Arduino IDE.

The first upload of this firmware still goes over USB. After that the cable is only needed if the
node cannot join Wi-Fi. The laptop must be on the same Wi-Fi as the node (if the node fell back to the
Pi's hotspot, join the hotspot too).

**Finding the node.** Its name is `gh-node-a.local` / `gh-node-b.local`; if Windows does not resolve
it, use the IP address: `sudo ghctl hw watch --node node_a` on the Pi shows it in the status message.
A DHCP reservation on the router keeps it fixed.

**Network log.** In PowerShell, from the repository folder:

```
powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-log.ps1 -Node gh-node-a.local
powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-log.ps1 -Node 192.168.1.23 -LogFile A13_soil.txt
```

It asks for the OTA password (hidden), then shows the log; `-LogFile` also saves it. PuTTY works too:
connection type **Telnet** (not Raw), port 23. Only one log connection at a time; three wrong
passwords close it. The password crosses the Wi-Fi unencrypted, so use one that protects nothing else.

| Command | What it does |
| --- | --- |
| `help` | List the commands |
| `status` | Firmware, uptime, Wi-Fi and signal, MQTT connection, sensors found, clock |
| `read` | Read every sensor now and print it; nothing is published |
| `soil [n]` | ADS1115 soil counts once a second, n times (max 300), then mean / min / max per probe. Same counts as the node publishes, so usable for the app's Calibration form. Type anything to stop; scheduled publishing continues |
| `scan` | List I²C devices (0x48 ADS1115, 0x23 / 0x5C BH1750) |
| `reboot` | Restart the node |
| `quit` | Close the network log |

The same commands work in the Serial Monitor over USB (no password there).

**OTA upload.** Arduino IDE: **Tools > Port**, pick the network port `gh-node-a at <ip>` (or
`gh-node-b`), then Upload; it asks for the OTA password. The node publishes `{"online":false}`,
takes the new firmware and restarts (about 30–60 s). Windows may ask to let python3 / espota through
the firewall: allow it on this network, since the node connects back to the laptop to fetch the file.
If the network port does not show, or the IDE does not ask for the password: **Sketch > Export
Compiled Binary**, then

```
powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-upload.ps1 -Node gh-node-a.local -Board esp8266
powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-upload.ps1 -Node gh-node-b.local -Board esp32
```

A wrong password or a cut-off upload leaves the old firmware running. If the network port never
appears and `ping` to the node's IP fails, the Wi-Fi may keep devices apart (client isolation): use
the Pi's hotspot or the USB cable.
