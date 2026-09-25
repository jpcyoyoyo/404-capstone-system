// Copy this file to config.h (same folder) and fill it in. config.h is git-ignored.
// One sketch serves both nodes: NODE_ID selects the zone, pins and sensor IDs.
#pragma once

#define NODE_ID        "node_a"            // "node_a" (ESP8266, Zone 1) or "node_b" (ESP32, Zone 2)

#define WIFI_SSID      "GreenhouseNet"     // the network the Pi is on (dedicated router recommended)
#define WIFI_PASS      "change-me"

#define MQTT_HOST      "192.168.50.10"     // the Pi's fixed address on this network (ROUTER_STATIC_IP in network.conf)
#define MQTT_PORT      1883
#define MQTT_USER      NODE_ID
#define MQTT_PASS      "from /etc/greenhouse/node-credentials.txt"

// Optional second network, tried when the first is out of range: the Pi's own hotspot
// (HOTSPOT_SSID in /etc/greenhouse/network.conf; the Pi is then always 10.42.0.1).
#define WIFI2_SSID     ""                  // leave empty to use only the first network
#define WIFI2_PASS     ""
#define MQTT_HOST2     "10.42.0.1"

#define GH_ID          "gh1"               // greenhouse.id in contract/registry.yaml
#define PUBLISH_MS     30000UL             // nodes[].publish_interval_s × 1000
