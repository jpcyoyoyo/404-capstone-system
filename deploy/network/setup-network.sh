#!/usr/bin/env bash
# Creates the three NetworkManager profiles from /etc/greenhouse/network.conf.
# Safe to re-run: existing greenhouse-* profiles are replaced.
set -euo pipefail
CONF=${1:-/etc/greenhouse/network.conf}
# shellcheck source=/dev/null
source "$CONF"
IFACE=${IFACE:-wlan0}

del() { nmcli -t -f NAME connection show | grep -qx "$1" && nmcli connection delete "$1" >/dev/null || true; }

if [[ -n "${MAGSO_SSID:-}" ]]; then
  del greenhouse-magso
  sec=(); [[ -n "${MAGSO_PSK:-}" ]] && sec=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$MAGSO_PSK")
  nmcli connection add type wifi ifname "$IFACE" con-name greenhouse-magso ssid "$MAGSO_SSID" \
    connection.autoconnect yes connection.autoconnect-priority 20 "${sec[@]}" >/dev/null
  echo "profile greenhouse-magso -> $MAGSO_SSID (DHCP; reach the Pi at http://greenhouse.local:8000)"
fi

if [[ -n "${ROUTER_SSID:-}" ]]; then
  del greenhouse-router
  sec=(); [[ -n "${ROUTER_PSK:-}" ]] && sec=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$ROUTER_PSK")
  nmcli connection add type wifi ifname "$IFACE" con-name greenhouse-router ssid "$ROUTER_SSID" \
    connection.autoconnect yes connection.autoconnect-priority 10 \
    ipv4.method manual ipv4.addresses "$ROUTER_STATIC_IP" ipv4.gateway "$ROUTER_GATEWAY" ipv4.dns "$ROUTER_GATEWAY" \
    "${sec[@]}" >/dev/null
  echo "profile greenhouse-router -> $ROUTER_SSID (Pi at ${ROUTER_STATIC_IP%/*})"
fi

del greenhouse-hotspot
nmcli connection add type wifi ifname "$IFACE" con-name greenhouse-hotspot ssid "$HOTSPOT_SSID" \
  connection.autoconnect no 802-11-wireless.mode ap 802-11-wireless.band bg \
  ipv4.method shared ipv4.addresses 10.42.0.1/24 \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$HOTSPOT_PSK" >/dev/null
echo "profile greenhouse-hotspot -> $HOTSPOT_SSID (Pi at 10.42.0.1), started by greenhouse-net when needed"
