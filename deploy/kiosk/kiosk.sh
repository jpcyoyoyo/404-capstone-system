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

# Screen never blanks
xset s off 2>/dev/null; xset -dpms 2>/dev/null; xset s noblank 2>/dev/null

# Wait for the API (it serves the page) — up to 3 minutes after boot
for _ in $(seq 1 90); do curl -fs "$HEALTH" >/dev/null && break; sleep 2; done

while true; do
  "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --incognito \
    --password-store=basic --disable-translate --disable-features=TranslateUI \
    --check-for-update-interval=31536000 --ozone-platform-hint=auto $KIOSK_EXTRA_FLAGS "$URL"
  sleep 5
done
