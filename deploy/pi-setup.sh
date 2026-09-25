#!/usr/bin/env bash
# One-time setup of the Raspberry Pi 5 controller (Raspberry Pi OS Bookworm, 64-bit, with desktop).
#
#   1. On a PC: cd app && npm ci && npm run build        (the Pi serves app/dist for the kiosk and browsers)
#   2. Copy the whole 404-capstone-system folder to the Pi (USB stick or scp)
#   3. On the Pi:  sudo ./deploy/pi-setup.sh             (add --sim to run with simulated sensors on the bench)
#
# Re-running is safe: secrets and existing data are kept; code, units and configs are refreshed.
set -euo pipefail

SIM=0
[[ "${1:-}" == "--sim" ]] && SIM=1
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
DEST=/opt/greenhouse
ETC=/etc/greenhouse
DESKTOP_USER=${SUDO_USER:-pi}
say() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
rand() { openssl rand -hex "${1:-16}"; }

[[ -f "$REPO/app/dist/index.html" ]] || { echo "app/dist is missing — build the app on a PC first (see top of this file)"; exit 1; }

say "Packages"
apt-get update
apt-get install -y python3-venv python3-dev build-essential mosquitto mosquitto-clients \
  avahi-daemon network-manager curl rsync openssl chromium-browser || \
apt-get install -y python3-venv python3-dev build-essential mosquitto mosquitto-clients \
  avahi-daemon network-manager curl rsync openssl chromium
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

say "Interfaces: I2C, UART0 (CO2), UART2 (level sensor), 1-Wire on GPIO18 (DS18B20)"
# SPI stays OFF: it would claim GPIO7-11, and GPIO8/GPIO7 drive relay inputs IN7/IN8.
# 1-Wire is NOT enabled through raspi-config, which puts it on GPIO4 (UART2 TX here).
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_i2c 0 || true
  raspi-config nonint do_spi 1 || true
  raspi-config nonint do_serial_hw 0 || true
  raspi-config nonint do_serial_cons 1 || true
  raspi-config nonint do_blanking 1 || true
fi
BOOTCFG=/boot/firmware/config.txt
[[ -f $BOOTCFG ]] || BOOTCFG=/boot/config.txt
if ! grep -q "# >>> greenhouse" "$BOOTCFG"; then
  printf '%s\n' "# >>> greenhouse (added by deploy/pi-setup.sh)" "dtparam=i2c_arm=on" "dtparam=uart0=on" \
    "dtoverlay=uart2-pi5" "dtoverlay=w1-gpio,gpiopin=18" "# <<< greenhouse" >> "$BOOTCFG"
  echo "boot configuration updated: reboot before testing sensors"
fi
hostnamectl set-hostname greenhouse   # reachable as greenhouse.local via avahi

say "Service account and files"
id greenhouse >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin greenhouse
for g in gpio i2c spi dialout; do getent group $g >/dev/null && usermod -aG $g greenhouse; done
mkdir -p "$DEST" "$ETC"
rsync -a --delete --exclude '__pycache__' --exclude '*.db' "$REPO/controller/" "$DEST/controller/"
rsync -a --delete "$REPO/contract/" "$DEST/contract/"
rsync -a --delete "$REPO/app/dist/" "$DEST/app/dist/"
rsync -a --exclude 'mysql.env' --exclude 'backup/' "$REPO/deploy/" "$DEST/deploy/"
chmod +x "$DEST"/deploy/*.sh "$DEST"/deploy/*/*.sh "$DEST"/deploy/network/greenhouse-net

say "Python environment"
[[ -d "$DEST/venv" ]] || python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install --upgrade pip wheel >/dev/null
if [[ $SIM -eq 1 ]]; then "$DEST/venv/bin/pip" install "$DEST/controller"
else "$DEST/venv/bin/pip" install "$DEST/controller[pi]"; fi
chown -R greenhouse:greenhouse "$DEST"

say "Secrets and settings"
if [[ ! -f "$ETC/greenhouse.env" ]]; then
  DB_PW=$(rand); MQ_PW=$(rand); APP_PW=$(rand); NODE_A=$(rand 8); NODE_B=$(rand 8)
  sed -e "s#CHANGE_ME_DB#$DB_PW#" -e "s#CHANGE_ME_MQTT#$MQ_PW#" -e "s#CHANGE_ME_APP#$APP_PW#" \
      -e "s#CHANGE_ME_64_HEX_CHARS#$(rand 32)#" "$REPO/deploy/greenhouse.env.example" > "$ETC/greenhouse.env"
  [[ $SIM -eq 1 ]] && sed -i 's#^GH_HAL=pi#GH_HAL=sim#' "$ETC/greenhouse.env"
  sed -e "s#CHANGE_ME_ROOT#$(rand)#" -e "s#CHANGE_ME_DB#$DB_PW#" "$REPO/deploy/mysql/mysql.env.example" > "$DEST/deploy/mysql/mysql.env"
  cat > "$ETC/node-credentials.txt" <<EOF
# MQTT accounts for the ESP nodes (put these in the node firmware config)
broker: greenhouse.local:1883 (or the Pi's address on the current network)
node_a / $NODE_A
node_b / $NODE_B
EOF
  : > /etc/mosquitto/greenhouse.passwd
  mosquitto_passwd -b /etc/mosquitto/greenhouse.passwd greenhouse "$MQ_PW"
  mosquitto_passwd -b /etc/mosquitto/greenhouse.passwd app "$APP_PW"
  mosquitto_passwd -b /etc/mosquitto/greenhouse.passwd node_a "$NODE_A"
  mosquitto_passwd -b /etc/mosquitto/greenhouse.passwd node_b "$NODE_B"
  chown mosquitto:mosquitto /etc/mosquitto/greenhouse.passwd
  chmod 600 "$ETC/greenhouse.env" "$ETC/node-credentials.txt" "$DEST/deploy/mysql/mysql.env" /etc/mosquitto/greenhouse.passwd
  chown greenhouse:greenhouse "$ETC/greenhouse.env"
  echo "new secrets written to $ETC/greenhouse.env (node MQTT passwords in $ETC/node-credentials.txt)"
else
  echo "keeping existing $ETC/greenhouse.env"
fi
[[ -f "$ETC/network.conf" ]] || cp "$REPO/deploy/network/network.conf.example" "$ETC/network.conf"

say "Mosquitto (1883 for nodes and services, 9001 WebSocket for the app)"
cp "$REPO/deploy/mosquitto/greenhouse.conf" /etc/mosquitto/conf.d/greenhouse.conf
cp "$REPO/deploy/mosquitto/greenhouse.acl" /etc/mosquitto/greenhouse.acl
systemctl enable mosquitto && systemctl restart mosquitto

say "MySQL 8 (Docker)"
mkdir -p /var/lib/greenhouse-mysql
cp "$REPO/deploy/systemd/greenhouse-db.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now greenhouse-db
echo -n "waiting for MySQL"
for _ in $(seq 1 60); do
  docker exec greenhouse-mysql mysqladmin ping -h 127.0.0.1 --silent >/dev/null 2>&1 && break
  echo -n "."; sleep 3
done; echo

say "Database schema and first administrator"
set -a; source "$ETC/greenhouse.env"; set +a
cd "$DEST/controller"
if [[ $SIM -eq 1 ]]; then sudo -E -u greenhouse "$DEST/venv/bin/greenhouse" init-db --sim
else sudo -E -u greenhouse "$DEST/venv/bin/greenhouse" init-db; fi
if [[ -z "$(docker exec greenhouse-mysql sh -c 'mysql -N -u root -p"$MYSQL_ROOT_PASSWORD" greenhouse -e "select count(*) from users"' 2>/dev/null | grep -v '^0$')" ]]; then
  read -rp "Administrator email: " ADMIN_EMAIL
  sudo -E -u greenhouse "$DEST/venv/bin/greenhouse" create-user "$ADMIN_EMAIL" --role admin
fi

say "Command-line helper: sudo ghctl <command>  (e.g. sudo ghctl hw list)"
cat > /usr/local/bin/ghctl <<'EOS'
#!/bin/sh
# Runs the greenhouse command line as the service account, with the service settings loaded.
set -a; . /etc/greenhouse/greenhouse.env; set +a
cd /opt/greenhouse/controller
exec sudo -E -u greenhouse /opt/greenhouse/venv/bin/greenhouse "$@"
EOS
chmod 755 /usr/local/bin/ghctl

say "Services"
for u in greenhouse-sensors greenhouse-control greenhouse-api greenhouse-sync greenhouse-simnodes; do
  cp "$REPO/deploy/systemd/$u.service" /etc/systemd/system/
done
cp "$REPO/deploy/network/greenhouse-net" /usr/local/sbin/greenhouse-net
cp "$REPO/deploy/network/greenhouse-net.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now greenhouse-sensors greenhouse-control greenhouse-api
if [[ $SIM -eq 1 ]]; then systemctl enable --now greenhouse-simnodes; else systemctl disable --now greenhouse-simnodes 2>/dev/null || true; fi
if grep -q '^GH_CLOUD_URL=.\+' "$ETC/greenhouse.env"; then systemctl enable --now greenhouse-sync; fi

say "Network fallback (MAgSO Wi-Fi > router > hotspot)"
echo "Edit $ETC/network.conf, then run: sudo $DEST/deploy/network/setup-network.sh && sudo systemctl enable --now greenhouse-net"

say "Kiosk display"
DESK_HOME=$(getent passwd "$DESKTOP_USER" | cut -d: -f6)
if [[ -n "$DESK_HOME" ]]; then
  install -d -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$DESK_HOME/.config/autostart"
  install -o "$DESKTOP_USER" -g "$DESKTOP_USER" -m 644 "$REPO/deploy/kiosk/greenhouse-kiosk.desktop" "$DESK_HOME/.config/autostart/"
  echo "kiosk starts on the next desktop login of $DESKTOP_USER (enable auto-login in raspi-config)"
fi

say "Nightly backup"
echo "15 2 * * * root $DEST/deploy/mysql/backup.sh >> /var/log/greenhouse-backup.log 2>&1" > /etc/cron.d/greenhouse-backup

say "Done"
IP=$(hostname -I | awk '{print $1}')
echo "API and app:  http://greenhouse.local:8000   (or http://$IP:8000)"
echo "Kiosk page:   http://localhost:8000/kiosk"
echo "API docs:     http://$IP:8000/docs"
echo "Check:        systemctl status 'greenhouse-*'   ·   journalctl -u greenhouse-control -f"
