// Smart Greenhouse sensing node — Node A (ESP8266) and Node B (ESP32).
// Publishes raw readings every PUBLISH_MS on gh/<GH_ID>/node/<NODE_ID>/raw (contract/schemas/node_raw).
// Calibration and quality flags are applied on the Pi, so recalibrating never needs a reflash.
// Settings come from the node's own config file, chosen by board: config_a.h for Node A (ESP8266),
// config_b.h for Node B (ESP32), otherwise config.h. All three are git-ignored; copy config.example.h.
//
// Wireless debugging (9 Nov 2026), on when the config file defines OTA_PASS (8 characters or more):
//  - network log: everything printed to the Serial Monitor also goes to one TCP client on port 23
//    (PuTTY "Telnet", or firmware/tools/node-log.ps1), after the password; commands as below.
//  - OTA uploads: the board shows in the Arduino IDE under Tools > Port as gh-node-a / gh-node-b.
// Commands (Serial Monitor or network log): help, status, read, soil [n], scan, reboot, quit.
#if defined(ESP8266) && __has_include("config_a.h")
  #include "config_a.h"
#elif defined(ESP32) && __has_include("config_b.h")
  #include "config_b.h"
#else
  #include "config.h"
#endif

#define FW_VERSION "2026-11-11 (network log + OTA, ESP32 tx 8.5 dBm)"

// ESP32 only: transmit power. The default (about 19.5 dBm) draws current peaks of about 240 mA in
// each transmit burst; 8.5 dBm lowers them. Test of 11 Nov 2026 for Node B's broker drops (A12 T9).
// Comment the line out to go back to the default.
#if defined(ESP32)
#define WIFI_TX_POWER WIFI_POWER_8_5dBm
#endif

#if defined(ESP32)
  #include <WiFi.h>
  #include <esp_system.h>
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

#if defined(OTA_PASS)
  #define NET_DEBUG 1
  #include <ArduinoOTA.h>
#else
  #define NET_DEBUG 0
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

// BH1750 measurement time register at its minimum (default 69): the range grows from 54,612 lux to about
// 121,000 lux, so real greenhouse light should never reach the top count, at about 1.9 lux per count.
static const uint8_t BH1750_MTREG = 31;
static const float LUX_FULL_SCALE = 65535.0f / 1.2f * (69.0f / BH1750_MTREG);

char topicRaw[64], topicStatus[64];
uint32_t seq = 0, lastPublish = 0, lastConnected = 0;
const char *brokerHost = MQTT_HOST;       // follows the network that connected

// ---------- Log: Serial Monitor, plus the network log client once it has given the password ----------
#if NET_DEBUG
WiFiServer telnetServer(23);
WiFiClient telnet;
bool telnetAuthed = false;
#endif

class NodeLog : public Print {
 public:
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t *buf, size_t n) override {
    Serial.write(buf, n);
#if NET_DEBUG
    if (telnetAuthed && telnet.connected()) {       // terminals want CR LF, the sketch prints LF
      size_t start = 0;
      for (size_t i = 0; i < n; i++) {
        if (buf[i] != '\n') continue;
        if (i > start) telnet.write(buf + start, i - start);
        telnet.write((const uint8_t *)"\r\n", 2);
        start = i + 1;
      }
      if (start < n) telnet.write(buf + start, n - start);
    }
#endif
    return n;
  }
};
NodeLog Log;

// Collects one typed line. Ends on CR or LF (PuTTY sends CR LF or CR NUL), handles backspace and
// skips telnet option bytes (IAC + 2), so it works for the Serial Monitor, PuTTY and the PowerShell script.
struct LineIn {
  char buf[64];
  uint8_t len = 0, iac = 0;
  bool lastCR = false;
  bool feed(int c) {
    if (c < 0) return false;
    if (iac) { iac--; return false; }
    if (c == 255) { iac = 2; return false; }
    if (c == '\r' || c == '\n') {
      bool skip = (c == '\n' && lastCR);
      lastCR = (c == '\r');
      if (skip) return false;
      buf[len] = 0; len = 0; return true;
    }
    lastCR = false;
    if (c == 8 || c == 127) { if (len) len--; return false; }
    if (c < 32 || len >= sizeof buf - 1) return false;
    buf[len++] = (char)c;
    return false;
  }
};
LineIn serialIn;

void serviceNet(bool commands);

// Waits without starving MQTT: a plain delay() longer than the keep-alive lets the broker drop the node.
// Also keeps OTA and the network log answering; typed commands wait until the main loop.
void waitServicing(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) { serviceNet(false); delay(10); }
}

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
#if defined(ESP8266)
  WiFi.setSleepMode(WIFI_NONE_SLEEP);      // mains powered: no modem sleep, steadier MQTT link
#else
  WiFi.setSleep(false);
#endif
  WiFi.disconnect();
  WiFi.begin(ssid, pass);
#if defined(ESP32) && defined(WIFI_TX_POWER)
  WiFi.setTxPower(WIFI_TX_POWER);          // after begin(): the radio must be started first
#endif
  Log.printf("wifi: connecting to %s", ssid);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Log.print('.'); }
  if (WiFi.status() == WL_CONNECTED) {
    Log.printf(" ok, ip %s rssi %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    brokerHost = (useSecond && haveSecond) ? MQTT_HOST2 : MQTT_HOST;
    mqtt.setServer(brokerHost, MQTT_PORT);
  } else {
    Log.println(" failed");
    if (haveSecond) useSecond = !useSecond;
  }
}

void connectMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  String clientId = String("gh-") + NODE_ID;
  Log.printf("mqtt: connecting to %s:%d as %s … ", brokerHost, MQTT_PORT, MQTT_USER);
  // Last will: the broker publishes {"online":false} (retained) if this node drops off.
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, topicStatus, 1, true, "{\"online\":false}")) {
    JsonDocument st;
    st["online"] = true;
    st["ip"] = WiFi.localIP().toString();
    st["rssi"] = WiFi.RSSI();
    putTimestamp(st);
    char buf[160]; size_t n = serializeJson(st, buf, sizeof buf);
    mqtt.publish(topicStatus, (const uint8_t *)buf, n, true);
    Log.println("ok");
  } else {
    int st = mqtt.state();
    Log.printf("failed, state %d (%s)\n", st,
               st == 4 || st == 5 ? "wrong user or password, or not allowed" :
               st <= -2 ? "no network connection to the broker" : "see PubSubClient states");
  }
}

// One light reading. A result at the top count (0xFFFF) is treated as a failed read, not as light:
// in A11 T9 Node A sent 54,612.5 lux (the old full scale) 15 times in an hour in a room at about 35 lux.
// Retries once, then reports "full_scale" so the Pi stores it INVALID and the controller holds the lights.
float readLux(const char *&err) {
  err = nullptr;
  if (!haveLight) { err = "bh1750_missing"; return -1; }
  float lux = -1;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (attempt) waitServicing(200);           // longer than one measurement (about 55 ms at MTreg 31)
    lux = lightMeter.readLightLevel();
    if (lux < 0) err = "read_failed";
    else if (lux >= LUX_FULL_SCALE * 0.999f) err = "full_scale";
    else { err = nullptr; return lux; }
  }
  return lux;
}

// Reads every sensor and prints it. send = false is the "read" command: printed only, nothing published,
// seq unchanged, so a debug reading never becomes a stored row on the Pi.
void publishReadings(bool send) {
  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  putTimestamp(doc);
  if (send) doc["seq"] = ++seq;
  JsonArray arr = doc["readings"].to<JsonArray>();

  float tv[3], hv[3];
  bool anyFailed = false;
  for (int i = 0; i < 3; i++) {
    tv[i] = dht[i].readTemperature();
    hv[i] = dht[i].readHumidity();
    if (isnan(tv[i]) || isnan(hv[i])) anyFailed = true;
  }
  if (anyFailed) {                         // one retry: the DHT22 needs 2 s between reads
    waitServicing(2100);                   // one shared wait, MQTT kept alive meanwhile
    for (int i = 0; i < 3; i++) {
      if (!isnan(tv[i]) && !isnan(hv[i])) continue;
      tv[i] = dht[i].readTemperature(false, true);
      hv[i] = dht[i].readHumidity(true);
    }
  }
  for (int i = 0; i < 3; i++) {
    float t = tv[i], h = hv[i];
    addReading(arr, sensorId("temp", i + 1), t, !isnan(t), "read_failed");
    addReading(arr, sensorId("hum", i + 1), h, !isnan(h), "read_failed");
    Log.printf("dht_%s_%02d  %6.1f C  %6.1f %%RH\n", ZONE, i + 1, t, h);
  }

  for (int ch = 0; ch < 3; ch++) {
    if (!haveAds) { addReading(arr, sensorId("soil", ch + 1), 0, false, "ads_missing"); continue; }
    int16_t counts = ads.readADC_SingleEnded(ch);
    bool ok = counts > -100;                // a disconnected input floats; negative counts mean a wiring fault
    addReading(arr, sensorId("soil", ch + 1), counts, ok, "out_of_range");
    Log.printf("soil_%s_%02d  %6d counts  %.3f V\n", ZONE, ch + 1, counts, ads.computeVolts(counts));
  }

  const char *lightErr = nullptr;
  float lux = readLux(lightErr);
  addReading(arr, sensorId("light", 1), lux, lightErr == nullptr, lightErr);
  Log.printf("light_%s_01 %8.1f lux%s%s\n", ZONE, lux, lightErr ? "  " : "", lightErr ? lightErr : "");

  if (!send) { Log.println("read only: not published\n"); return; }
  char buf[1024];
  size_t n = serializeJson(doc, buf, sizeof buf);
  bool sent = mqtt.connected() && mqtt.publish(topicRaw, (const uint8_t *)buf, n, false);
  Log.printf("publish seq %lu: %u bytes %s\n\n", (unsigned long)seq, (unsigned)n, sent ? "sent" : "NOT SENT (offline)");
}

// Scheduled publish, also called from inside long commands (soil n) so the Pi never sees a gap.
void publishIfDue() {
  if (millis() - lastPublish >= PUBLISH_MS) {
    lastPublish = millis();
    publishReadings(true);
  }
}

// ---------- Commands ----------
bool inputWaiting() {
  if (Serial.available()) return true;
#if NET_DEBUG
  if (telnetAuthed && telnet.connected() && telnet.available()) return true;
#endif
  return false;
}
void drainInput() {
  while (Serial.available()) Serial.read();
#if NET_DEBUG
  while (telnet.connected() && telnet.available()) telnet.read();
#endif
}

void cmdStatus() {
  uint32_t s = millis() / 1000;
  Log.printf("node %s (zone %s), firmware %s\n", NODE_ID, ZONE, FW_VERSION);
#if defined(ESP8266)
  Log.printf("uptime %lu d %02lu:%02lu:%02lu, free heap %u bytes, last reset: %s\n",
             (unsigned long)(s / 86400), (unsigned long)(s / 3600 % 24), (unsigned long)(s / 60 % 60), (unsigned long)(s % 60),
             (unsigned)ESP.getFreeHeap(), ESP.getResetReason().c_str());
#else
  Log.printf("uptime %lu d %02lu:%02lu:%02lu, free heap %u bytes, last reset code %d\n",
             (unsigned long)(s / 86400), (unsigned long)(s / 3600 % 24), (unsigned long)(s / 60 % 60), (unsigned long)(s % 60),
             (unsigned)ESP.getFreeHeap(), (int)esp_reset_reason());
#endif
  if (WiFi.status() == WL_CONNECTED)
  {
    Log.printf("wifi: %s, ip %s, rssi %d dBm\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
#if defined(ESP32)
    Log.printf("wifi: tx power %.2f dBm\n", (int)WiFi.getTxPower() / 4.0);   // reported in 0.25 dBm steps
#endif
  }
  else
    Log.println("wifi: not connected");
  Log.printf("mqtt: %s %s:%d, last seq %lu, every %lu s\n", mqtt.connected() ? "connected to" : "NOT connected to",
             brokerHost, MQTT_PORT, (unsigned long)seq, (unsigned long)(PUBLISH_MS / 1000));
  Log.printf("sensors: bh1750 0x%02X %s, ads1115 0x48 %s\n", BH1750_ADDR, haveLight ? "found" : "MISSING", haveAds ? "found" : "MISSING");
  time_t now = time(nullptr);
  if (now < 1700000000) Log.println("time: not synced (readings go out with ts null)");
  else { struct tm t; gmtime_r(&now, &t); char b[24]; strftime(b, sizeof b, "%Y-%m-%d %H:%M:%S", &t); Log.printf("time: %s UTC\n", b); }
}

// soil [n]: ADS1115 counts once a second, n times (1–300), then mean / min / max per channel.
// These are the same counts the node publishes, so they can go into the app's Calibration form (A13).
// Typing anything stops it early; scheduled publishing carries on meanwhile.
void cmdSoil(const char *arg) {
  if (!haveAds) { Log.println("soil: ads1115 not found (try scan)"); return; }
  int n = arg && *arg ? atoi(arg) : 1;
  if (n < 1) n = 1;
  if (n > 300) n = 300;
  long sum[3] = {0, 0, 0};
  int16_t mn[3] = {32767, 32767, 32767}, mx[3] = {-32768, -32768, -32768};
  int done = 0;
  drainInput();
  for (int k = 0; k < n; k++) {
    if (k) {
      waitServicing(1000);
      publishIfDue();
      if (inputWaiting()) { drainInput(); Log.println("soil: stopped"); break; }
    }
    Log.printf("soil %3d/%d", k + 1, n);
    for (int ch = 0; ch < 3; ch++) {
      int16_t c = ads.readADC_SingleEnded(ch);
      sum[ch] += c; if (c < mn[ch]) mn[ch] = c; if (c > mx[ch]) mx[ch] = c;
      Log.printf("  %s_%02d %6d (%.3f V)", ZONE, ch + 1, c, ads.computeVolts(c));
    }
    Log.println();
    done++;
  }
  if (done > 1) {
    for (int ch = 0; ch < 3; ch++) {
      int16_t mean = (int16_t)lround((double)sum[ch] / done);
      Log.printf("soil_%s_%02d  mean %6d counts (%.3f V)  min %6d  max %6d  over %d readings\n",
                 ZONE, ch + 1, mean, ads.computeVolts(mean), mn[ch], mx[ch], done);
    }
  }
}

void cmdScan() {
  int found = 0;
  Log.print("i2c:");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() != 0) continue;
    found++;
    Log.printf(" 0x%02X%s", a, a == 0x48 ? " (ads1115)" : (a == 0x23 || a == 0x5C) ? " (bh1750)" : "");
  }
  Log.printf(found ? "\n" : " nothing found (check SDA, SCL, 3V3 and GND)\n");
}

void runCommand(char *line, bool fromNet) {
  while (*line == ' ') line++;
  if (!*line) return;
  char *arg = strchr(line, ' ');
  if (arg) { *arg++ = 0; while (*arg == ' ') arg++; }
  for (char *p = line; *p; p++) *p = tolower(*p);
  if (!strcmp(line, "help")) {
    Log.println("help        this list");
    Log.println("status      firmware, uptime, Wi-Fi, MQTT, sensors found, time");
    Log.println("read        read every sensor now and print it (not published)");
    Log.println("soil [n]    ADS1115 soil counts once a second, n times (max 300), then mean/min/max; type anything to stop");
    Log.println("scan        list I2C devices (0x48 ads1115, 0x23 / 0x5C bh1750)");
    Log.println("reboot      restart the node");
    Log.println("quit        close the network log (network only)");
  } else if (!strcmp(line, "status")) cmdStatus();
  else if (!strcmp(line, "read")) publishReadings(false);
  else if (!strcmp(line, "soil")) cmdSoil(arg);
  else if (!strcmp(line, "scan")) cmdScan();
  else if (!strcmp(line, "reboot")) {
    Log.println("rebooting");
    delay(200);
#if NET_DEBUG
    if (telnet.connected()) telnet.stop();
#endif
    ESP.restart();
  } else if (!strcmp(line, "quit") || !strcmp(line, "exit")) {
#if NET_DEBUG
    if (fromNet) { Log.println("network log closed"); telnetAuthed = false; telnet.stop(); return; }
#endif
    Log.println("quit only applies to the network log");
  } else Log.printf("unknown command '%s' (type help)\n", line);
}

// ---------- Wireless debugging: OTA uploads and the network log ----------
#if NET_DEBUG
bool netStarted = false, otaActive = false;
LineIn telnetIn;
uint8_t telnetTries = 0;
uint32_t telnetLockUntil = 0;
static const uint8_t IAC_WILL_ECHO[3] = {255, 251, 1}, IAC_WONT_ECHO[3] = {255, 252, 1};

// Starts once, the first time Wi-Fi connects. A short or missing password leaves it off.
void startNetServices() {
  if (netStarted || WiFi.status() != WL_CONNECTED) return;
  netStarted = true;
  if (strlen(OTA_PASS) < 8) {
    Log.println("net: OTA_PASS is shorter than 8 characters, OTA and network log stay off");
    return;
  }
  char host[24];
  snprintf(host, sizeof host, "gh-%s", NODE_ID);
  for (char *p = host; *p; p++) if (*p == '_') *p = '-';   // hostnames cannot contain "_"
  ArduinoOTA.setHostname(host);
  ArduinoOTA.setPassword(OTA_PASS);
  ArduinoOTA.onStart([]() {
    otaActive = true;
    Log.println("ota: receiving new firmware, readings paused");
    if (mqtt.connected()) {                // same payload as the last will, so the Pi shows it offline
      mqtt.publish(topicStatus, "{\"online\":false}", true);
      mqtt.disconnect();
    }
  });
  ArduinoOTA.onProgress([](unsigned int done, unsigned int total) {
    static int lastTen = -1;
    int ten = total ? (int)(done * 10ULL / total) : 0;
    if (ten != lastTen) { lastTen = ten; Log.printf("ota: %d %%\n", ten * 10); }
  });
  ArduinoOTA.onEnd([]() { Log.println("ota: done, restarting"); });
  ArduinoOTA.onError([](ota_error_t e) {
    otaActive = false;
    Log.printf("ota: failed, error %d (%s); still on the old firmware\n", (int)e,
               e == OTA_AUTH_ERROR ? "wrong OTA password" : e == OTA_BEGIN_ERROR ? "not enough space" :
               e == OTA_CONNECT_ERROR ? "laptop not reachable: firewall?" : e == OTA_RECEIVE_ERROR ? "transfer cut off" : "end failed");
  });
  ArduinoOTA.begin();
  telnetServer.begin();
  telnetServer.setNoDelay(true);
  Log.printf("net: OTA as %s, network log on %s port 23\n", host, WiFi.localIP().toString().c_str());
}

void handleTelnet(bool commands) {
  if (!netStarted) return;
  WiFiClient incoming = telnetServer.accept();
  if (incoming) {
    if (telnet.connected()) { telnet.print("\r\nanother connection took over\r\n"); telnet.stop(); }
    telnet = incoming;
    telnet.setNoDelay(true);
    telnetAuthed = false; telnetTries = 0; telnetIn = LineIn();
    Serial.printf("net: connection from %s\n", telnet.remoteIP().toString().c_str());
    telnet.printf("\r\nSmart Greenhouse %s, firmware %s\r\npassword: ", NODE_ID, FW_VERSION);
    telnet.write(IAC_WILL_ECHO, 3);        // asks a telnet client not to show the password
  }
  if (!telnet.connected()) { telnetAuthed = false; return; }
  if (!commands || (int32_t)(millis() - telnetLockUntil) < 0) return;
  while (telnet.connected() && telnet.available()) {
    if (!telnetIn.feed(telnet.read())) continue;
    if (!telnetAuthed) {
      if (!telnetIn.buf[0]) continue;
      if (strcmp(telnetIn.buf, OTA_PASS) == 0) {
        telnet.write(IAC_WONT_ECHO, 3);
        telnetAuthed = true;
        telnet.print("\r\nok. Type help for commands.\r\n");
        Log.printf("net: network log opened from %s\n", telnet.remoteIP().toString().c_str());
      } else if (++telnetTries >= 3) {
        telnet.print("\r\nwrong password, closing\r\n");
        Serial.printf("net: 3 wrong passwords from %s, closed\n", telnet.remoteIP().toString().c_str());
        telnet.stop();
      } else {
        telnet.print("\r\nwrong password\r\npassword: ");
        telnetLockUntil = millis() + 2000;  // slows down guessing
      }
      return;
    }
    runCommand(telnetIn.buf, true);
    if (!telnet.connected()) return;
  }
}
#endif

void handleSerial(bool commands) {
  if (!commands) return;
  while (Serial.available())
    if (serialIn.feed(Serial.read())) runCommand(serialIn.buf, false);
}

void serviceNet(bool commands) {
  mqtt.loop();
#if NET_DEBUG
  startNetServices();
  if (netStarted && strlen(OTA_PASS) >= 8) { ArduinoOTA.handle(); handleTelnet(commands); }
#endif
  handleSerial(commands);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Log.printf("\nSmart Greenhouse %s (zone %s), firmware %s\n", NODE_ID, ZONE, FW_VERSION);
  WiFi.persistent(false);   // do not rewrite flash on every connect
  snprintf(topicRaw, sizeof topicRaw, "gh/%s/node/%s/raw", GH_ID, NODE_ID);
  snprintf(topicStatus, sizeof topicStatus, "gh/%s/node/%s/status", GH_ID, NODE_ID);

  Wire.begin(PIN_SDA, PIN_SCL);
  for (auto &d : dht) d.begin();
  haveLight = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  if (haveLight && !lightMeter.setMTreg(BH1750_MTREG)) Log.println("bh1750: setMTreg failed");
  haveAds = ads.begin(0x48);
  if (haveAds) ads.setGain(GAIN_ONE);      // ±4.096 V, 0.125 mV per count
  Log.printf("bh1750 0x%02X: %s   ads1115 0x48: %s\n", BH1750_ADDR, haveLight ? "found" : "MISSING", haveAds ? "found" : "MISSING");
#if !NET_DEBUG
  Log.println("net: OTA and network log off (no OTA_PASS in the config file)");
#endif

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // optional: ts stays null without internet
  mqtt.setKeepAlive(8);                   // broker detects a lost node in about 12 s (A11 T8: 15 s)
  mqtt.setBufferSize(1024);
  connectMqtt();
  lastPublish = millis() - PUBLISH_MS + 3000;   // first reading 3 s after boot
  lastConnected = millis();
}

void loop() {
  static uint32_t lastTry = 0;
#if NET_DEBUG
  if (otaActive) { serviceNet(false); delay(1); return; }   // an upload is running: nothing else
#endif
  if (WiFi.status() != WL_CONNECTED || !mqtt.connected()) {
    if (millis() - lastTry > 5000) { lastTry = millis(); connectWifi(); connectMqtt(); }
    if (millis() - lastConnected > 300000UL) {   // 5 minutes without the broker: start clean
      Log.println("offline for 5 min, restarting");
      ESP.restart();
    }
  } else {
    lastConnected = millis();
  }
  serviceNet(true);
  publishIfDue();
  delay(10);
}
