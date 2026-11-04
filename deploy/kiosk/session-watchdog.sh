#!/usr/bin/env bash
# Signs the kiosk desktop back in when it has died. Run every minute by greenhouse-session-watchdog.timer.
#
# 5 Nov 2026, 02:01: the HDMI link dropped (kernel: EDID block 0 is all zeroes) and labwc aborted
# (wlr_swapchain_create: Assertion `width > 0 && height > 0' failed). LightDM then showed its login
# screen instead of logging in again (auto-login only happens when LightDM starts), so the screen
# stayed blank until a reboot at 07:30. kiosk.sh cannot draw without a desktop.
#
# If the login screen is up and the auto-login user has no desktop on two checks in a row, this
# restarts LightDM, which logs in again; the new desktop starts kiosk.sh, and kiosk.sh stops its old copy.
# At most one restart every 10 minutes. A deliberate log-out is undone the same way; to keep the
# login screen, stop the timer first: sudo systemctl stop greenhouse-session-watchdog.timer
set -u
CONF=/etc/lightdm/lightdm.conf
STATE=/run/greenhouse-session-watchdog
LAST=/run/greenhouse-session-watchdog.last

user=$(sed -n 's/^[[:space:]]*autologin-user[[:space:]]*=[[:space:]]*//p' "$CONF" 2>/dev/null | tail -n 1)
[ -n "$user" ] || exit 0                                    # no auto-login set up: nothing to bring back

greeter=0; pgrep -u lightdm -f greeter >/dev/null 2>&1 && greeter=1
desktop=0; { pgrep -u "$user" -x labwc || pgrep -u "$user" -x wayfire; } >/dev/null 2>&1 && desktop=1

if [ "$greeter" = 0 ] || [ "$desktop" = 1 ]; then
  rm -f "$STATE"; exit 0                                    # normal: the desktop is up
fi
if [ ! -f "$STATE" ]; then
  touch "$STATE"; exit 0                                    # first sighting: check again in a minute
fi
now=$(date +%s); last=$(cat "$LAST" 2>/dev/null || echo 0)
if [ $((now - last)) -lt 600 ]; then
  exit 0                                                    # restarted less than 10 minutes ago
fi
rm -f "$STATE"; echo "$now" > "$LAST"
logger -t greenhouse-session-watchdog "login screen up and no desktop for $user: restarting lightdm"
systemctl --no-block restart lightdm
