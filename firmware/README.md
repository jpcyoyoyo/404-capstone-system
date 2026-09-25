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

1. Copy `config.example.h` to `config.h` and fill in Wi-Fi, the Pi's address and the node's MQTT
   password (`sudo cat /etc/greenhouse/node-credentials.txt` on the Pi).
2. Select the board, upload, and open the Serial Monitor at 115200 baud.
3. On the Pi: `sudo ghctl hw watch --node node_a`.

The node publishes raw values only (DHT22 °C and %RH, BH1750 lux, ADS1115 counts at ±4.096 V).
A failed read is sent as `"raw": null, "ok": false` with an error code, never as 0.
Status is retained on `gh/gh1/node/<id>/status` with a last will of `{"online": false}`.
