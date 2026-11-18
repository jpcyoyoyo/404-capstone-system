# App icons

Every icon of the app comes from one design: the white leaf (ionicons `leaf`) on the green
diagonal `#22c55e → #15803d`, as in the installed web app (`public/icons/icon-512.png`,
`icon-192.png`, `icon-maskable-512.png`). `make_icons.py` makes the rest from it:

| File | Where it shows |
|---|---|
| `public/favicon.png` | Browser tab (the web app, the cloud address and the Pi's display) |
| `public/icons/badge-96.png` | Android status bar, beside a notification (white leaf; Android uses its shape only) |
| `public/icons/alerts/*.png` | The picture in each notification, one per kind of alert (62 files) |
| `assets/icon-only.png`, `icon-foreground.png`, `icon-background.png` | Android app launcher icon (sources) |
| `assets/splash.png`, `splash-dark.png` | Android app start-up screen (sources) |

## Notification pictures

The cloud server picks the picture for each alert (`controller/greenhouse/push.py`, `alert_icon`)
and sends its path with the notification; `public/sw.js` shows it, or the app icon if none is given.
Colour by kind of problem: blue water, teal sensors, grey network and cloud, amber limits and
faults, red emergency stop, purple fertilizer dosing, orange power, green crop and summaries.
Sensor alerts show the team's own drawing of that sensor (`src/assets/sensors`) with a mark for
what is wrong: **!** bad readings, a clock for not reporting, sliders for needs calibration.
Other glyphs are from Lucide (lucide-static 0.460.0, ISC licence).

## Android launcher icon and splash screen

The `android/` folder is not in the repository, so its icons are made on the laptop from the
sources in `assets/`:

```
cd app
npx @capacitor/assets@3.0.5 generate --android
npm run android:sync
```

Then build the APK in Android Studio as usual (`npm run android:open`). The first command
replaces the Capacitor logo in `android/app/src/main/res` (launcher icons for every screen
density, round and adaptive, and the start-up screen in light and dark).

## Making them again

After changing the design or adding an alert picture (also add it to `ALERT_ICON` in `push.py`):

```
cd app
npm install --no-save lucide-static@0.460.0
python icon-src/make_icons.py node_modules/lucide-static/icons
```

Needs Python with Pillow and Playwright (`pip install pillow playwright`, then
`playwright install chromium`). `controller/tests/test_push.py` checks that every alert has its
picture.
