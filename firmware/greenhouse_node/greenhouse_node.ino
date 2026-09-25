// Smart Greenhouse sensing node — Node A (ESP8266) and Node B (ESP32).
// Publishes raw readings every PUBLISH_MS on gh/<GH_ID>/node/<NODE_ID>/raw (contract/schemas/node_raw).
// Calibration and quality flags are applied on the Pi, so recalibrating never needs a reflash.
#include "config.h"

#if defined(ESP32)
  #include <WiFi.h>
  static const uint8_t PIN_SDA = 21, PIN_SCL = 22;
  static const uint8_t DHT_PINS[3] = {25, 26, 27};
  static const uint8_t BH1750_ADDR = 0x5C;   // ADDR pin tied to 3.3 V
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  static const uint8_t PIN_SDA = 4, PIN_SCL = 5;          // D2, D1
  static const uint8_t DHT_PINS[3] = {14, 12, 13};        // D5, D6, D7
  static const uint8_t BH1750_ADDR = 0x23;   // ADDR pin to GND or open
#else
  #error "Select an ESP8266 or ESP32 board"
#endif

#include <Wire.h>
#include <DHT.h>
#include <BH1750.h>
#include <Adafruit_ADS1X15.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

static const char *ZONE = (strcmp(NODE_ID, "node_a") == 0) ? "z1" : "z2";

WiFiClient net;
PubSubClient mqtt(net);
DHT dht[3] = {DHT(DHT_PINS[0], DHT22), DHT(DHT_PINS[1], DHT22), DHT(DHT_PINS[2], DHT22)};
BH1750 lightMeter(BH1750_ADDR);
Adafruit_ADS1115 ads;
bool haveLight = false, haveAds = false;

char topicRaw[64], topicStatus[64];
uint32_t seq = 0, lastPublish = 0, lastConnected = 0;

String sensorId(const char *prefix, int n) {
  char buf[24];
  snprintf(buf, sizeof buf, "%s_%s_%02d", prefix, ZONE, n);
  return String(buf);
}

void addReading(JsonArray arr, const String &id, float raw, bool ok, const char *err) {
  JsonObject r = arr.add<JsonObject>();
  r["sensor_id"] = id;
  if (ok) r["raw"] = raw; else r["raw"] = nullptr;
  r["ok"] = ok;
  if (!ok && err) r["error"] = err;
}

// ISO-8601 UTC if NTP has synced, otherwise null (the Pi then stamps the arrival time).
void putTimestamp(JsonDocument &doc) {
  time_t now = time(nullptr);
  if (now < 1700000000) { doc["ts"] = nullptr; return; }
  struct tm t; gmtime_r(&now, &t);
  char buf[24]; strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", &t);
  doc["ts"] = buf;
}

// Tries the main network, then (if configured) the Pi's hotspot, alternating on each failure.
// The broker address follows the network that connected.
static bool useSecond = false;
void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  bool haveSecond = strlen(WIFI2_SSID) > 0;
  const char *ssid = (useSecond && haveSecond) ? WIFI2_SSID : WIFI_SSID;
  const char *pass = (useSecond && haveSecond) ? WIFI2_PASS : WIFI_PASS;
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  WiFi.begin(ssid, pass);
  Serial.printf("wifi: connecting to %s", ssid);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print('.'); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(" ok, ip %s rssi %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    mqtt.setServer((useSecond && haveSecond) ? MQTT_HOST2 : MQTT_HOST, MQTT_PORT);
  } else {
    Serial.println(" failed");
    if (haveSecond) useSecond = !useSecond;
  }
}

void connectMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  String clientId = String("gh-") + NODE_ID;
  Serial.printf("mqtt: connecting to %s:%d as %s … ", MQTT_HOST, MQTT_PORT, MQTT_USER);
  // Last will: the broker publishes {"online":false} (retained) if this node drops off.
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, topicStatus, 1, true, "{\"online\":false}")) {
    JsonDocument st;
    st["online"] = true;
    st["ip"] = WiFi.localIP().toString();
    st["rssi"] = WiFi.RSSI();
    putTimestamp(st);
    char buf[160]; size_t n = serializeJson(st, buf, sizeof buf);
    mqtt.publish(topicStatus, (const uint8_t *)buf, n, true);
    Serial.println("ok");
  } else {
    Serial.printf("failed, state %d (4/5 = wrong user or password)\n", mqtt.state());
  }
}

void publishReadings() {
  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  putTimestamp(doc);
  doc["seq"] = ++seq;
  JsonArray arr = doc["readings"].to<JsonArray>();

  for (int i = 0; i < 3; i++) {
    float t = dht[i].readTemperature();
    float h = dht[i].readHumidity();
    if (isnan(t) || isnan(h)) {            // one retry: the DHT22 needs 2 s between reads
      delay(2100);
      t = dht[i].readTemperature(false, true);
      h = dht[i].readHumidity(true);
    }
    addReading(arr, sensorId("temp", i + 1), t, !isnan(t), "read_failed");
    addReading(arr, sensorId("hum", i + 1), h, !isnan(h), "read_failed");
    Serial.printf("dht_%s_%02d  %6.1f C  %6.1f %%RH\n", ZONE, i + 1, t, h);
  }

  for (int ch = 0; ch < 3; ch++) {
    if (!haveAds) { addReading(arr, sensorId("soil", ch + 1), 0, false, "ads_missing"); continue; }
    int16_t counts = ads.readADC_SingleEnded(ch);
    bool ok = counts > -100;                // a disconnected input floats; negative counts mean a wiring fault
    addReading(arr, sensorId("soil", ch + 1), counts, ok, "out_of_range");
    Serial.printf("soil_%s_%02d  %6d counts  %.3f V\n", ZONE, ch + 1, counts, ads.computeVolts(counts));
  }

  float lux = haveLight ? lightMeter.readLightLevel() : -1;
  addReading(arr, sensorId("light", 1), lux, lux >= 0, haveLight ? "read_failed" : "bh1750_missing");
  Serial.printf("light_%s_01 %8.1f lux\n", ZONE, lux);

  char buf[1024];
  size_t n = serializeJson(doc, buf, sizeof buf);
  bool sent = mqtt.connected() && mqtt.publish(topicRaw, (const uint8_t *)buf, n, false);
  Serial.printf("publish seq %lu: %u bytes %s\n\n", (unsigned long)seq, (unsigned)n, sent ? "sent" : "NOT SENT (offline)");
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nSmart Greenhouse %s (zone %s)\n", NODE_ID, ZONE);
  WiFi.persistent(false);   // do not rewrite flash on every connect
  snprintf(topicRaw, sizeof topicRaw, "gh/%s/node/%s/raw", GH_ID, NODE_ID);
  snprintf(topicStatus, sizeof topicStatus, "gh/%s/node/%s/status", GH_ID, NODE_ID);

  Wire.begin(PIN_SDA, PIN_SCL);
  for (auto &d : dht) d.begin();
  haveLight = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  haveAds = ads.begin(0x48);
  if (haveAds) ads.setGain(GAIN_ONE);      // ±4.096 V, 0.125 mV per count
  Serial.printf("bh1750 0x%02X: %s   ads1115 0x48: %s\n", BH1750_ADDR, haveLight ? "found" : "MISSING", haveAds ? "found" : "MISSING");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // optional: ts stays null without internet
  mqtt.setKeepAlive(5);                   // broker detects a lost node in about 8 s
  mqtt.setBufferSize(1024);
  connectMqtt();
  lastPublish = millis() - PUBLISH_MS + 3000;   // first reading 3 s after boot
  lastConnected = millis();
}

void loop() {
  static uint32_t lastTry = 0;
  if (WiFi.status() != WL_CONNECTED || !mqtt.connected()) {
    if (millis() - lastTry > 5000) { lastTry = millis(); connectWifi(); connectMqtt(); }
    if (millis() - lastConnected > 300000UL) {   // 5 minutes without the broker: start clean
      Serial.println("offline for 5 min, restarting");
      ESP.restart();
    }
  } else {
    lastConnected = millis();
  }
  mqtt.loop();
  if (millis() - lastPublish >= PUBLISH_MS) {
    lastPublish = millis();
    publishReadings();
  }
  delay(10);
}
