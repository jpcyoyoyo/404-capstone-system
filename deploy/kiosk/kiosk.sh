#!/usr/bin/env bash
# Starts the greenhouse wall display: Chromium in kiosk mode on the Pi's own screen,
# showing the read-only /kiosk page served by the controller. Restarts it if it exits.
# Optional overrides in /etc/greenhouse/kiosk.conf, e.g.
#   KIOSK_EXTRA_FLAGS="--disable-gpu"            (blank, white or black window)
#   KIOSK_EXTRA_FLAGS="--ozone-platform=x11"     (window never appears under Wayland/labwc)
[ -f /etc/greenhouse/kiosk.conf ] && . /etc/greenhouse/kiosk.conf
URL=${KIOSK_URL:-http://localhost:8000/kiosk}
HEALTH=${KIOSK_HEALTH:-http://localhost:8000/health}
BROWSER=$(command -v chromium-browser || command -v chromium)
# Chromium leaves a 4 MB BrowserMetrics file behind on every start. On 31 Oct 2026 a crash loop
# (one restart about every 9 s from 01:03) left 3,805 of them, 15 GB, and filled the SD card.
METRICS="$HOME/.config/chromium/BrowserMetrics"
LOG=${KIOSK_LOG:-$HOME/.cache/greenhouse-kiosk.log}
ERR="$LOG.chromium"
mkdir -p "$(dirname "$LOG")"

# Screen never blanks (X11 only; under labwc turn blanking off in raspi-config, Display Options)
xset s off 2>/dev/null; xset -dpms 2>/dev/null; xset s noblank 2>/dev/null

# Wait for the API (it serves the page) — up to 3 minutes after boot
for _ in $(seq 1 90); do curl -fs "$HEALTH" >/dev/null && break; sleep 2; done

fast=0
while true; do
  find "$METRICS" -type f -name 'BrowserMetrics*' -delete 2>/dev/null
  started=$(date +%s)
  "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --incognito \
    --password-store=basic --disable-translate --disable-features=TranslateUI \
    --check-for-update-interval=31536000 --ozone-platform-hint=auto $KIOSK_EXTRA_FLAGS "$URL" \
    2>"$ERR"
  code=$?
  ran=$(( $(date +%s) - started ))

  # One line per exit, plus Chromium's last messages when it died within a minute
  echo "$(date '+%F %T') chromium exited, code $code, after ${ran} s" >> "$LOG"
  if [ "$ran" -lt 60 ]; then
    fast=$((fast + 1))
    tail -n 5 "$ERR" | sed 's/^/    /' >> "$LOG"
  else
    fast=0
  fi
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

  # Back off when it keeps failing: 5 s, then 30 s after 3 quick exits, 5 min after 10
  if   [ "$fast" -ge 10 ]; then sleep 300
  elif [ "$fast" -ge 3 ];  then sleep 30
  else sleep 5
  fi
done
