"""Make the app's icon files from one design: the white ionicons leaf on the green diagonal of the
PWA icon (public/icons/icon-512.png and icon-maskable-512.png), and the notification icons.

Writes (paths relative to app/):
  public/favicon.png              the browser tab icon: public/icons/icon-512.png made small
  public/icons/badge-96.png       the leaf alone, white on transparent: the small monochrome icon
                                  Android shows in the status bar for a notification
  public/icons/alerts/*.png       one 192 px picture per kind of alert, sent with each notification
                                  (controller/greenhouse/push.py, alert_icon)
  assets/icon-*.png, splash*.png  sources for the Android app's launcher icon and splash screen;
                                  `npx @capacitor/assets generate --android` turns them into
                                  android/app/src/main/res (see icon-src/README.md)

Run from app/, after `npm install` (for ionicons) and with lucide-static unpacked somewhere:
  npm install --no-save lucide-static@0.460.0
  python icon-src/make_icons.py node_modules/lucide-static/icons
It needs Python with Pillow and Playwright (Chromium draws the SVGs).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent
LUCIDE = Path(sys.argv[1]) if len(sys.argv) > 1 else APP / "node_modules/lucide-static/icons"
SENSORS = APP / "src/assets/sensors"
LEAF_D = re.search(r'd="([^"]+)"', (APP / "node_modules/ionicons/dist/svg/leaf.svg").read_text()).group(1)

GREEN_A, GREEN_B = "#22c55e", "#15803d"          # the PWA icon's diagonal, top left to bottom right

# ── the app icon ────────────────────────────────────────────────────────────
def leaf(frac: float, colour: str = "#fff") -> str:
    """The leaf glyph in a 512 box, its own 512 box scaled to `frac` of it and centred."""
    s, o = frac, 256 * (1 - frac)
    return f'<g transform="translate({o:.3f} {o:.3f}) scale({s:.5f})"><path fill="{colour}" d="{LEAF_D}"/></g>'


def gradient(rx: float = 0) -> str:
    return ('<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{GREEN_A}"/><stop offset="1" stop-color="{GREEN_B}"/></linearGradient></defs>'
            f'<rect width="512" height="512" rx="{rx}" fill="url(#g)"/>')


def svg512(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">{body}</svg>'


# Leaf size as a share of the icon's width, measured on the PWA icons (a vector copy differs from
# them only in edge anti-aliasing): 0.578 in icon-512.png, 0.457 in the full-bleed maskable one.
# @capacitor/assets places the Android foreground on the visible part of the adaptive icon (inset
# 16.7 %), so the launcher icon takes icon-512's proportion and looks like the web app's icon.
ANY_LEAF = 0.578

# ── notification icons ──────────────────────────────────────────────────────
# Colour by kind of problem, so the picture tells it apart at a glance; the title says how urgent.
WATER, SENSOR, NETWORK, LIMIT, STOP, DOSE, POWER, OK = (
    "#0369a1", "#0f766e", "#475569", "#b45309", "#b91c1c", "#7e22ce", "#c2410c", "#15803d")
CROP = "crop"                                    # the app icon's green diagonal

# The team's own sensor drawings (src/assets/sensors, the same as the app's sensor lists),
# by the registry's sensor type (contract/registry.yaml).
SENSOR_SVG = {
    "temperature": "dht22-temperature", "humidity": "dht22-humidity", "soil_moisture": "soil-capacitive",
    "light": "bh1750", "co2": "mhz19b", "ph": "ph-probe", "ec": "tds-probe", "water_temperature": "ds18b20",
    "water_level": "ultrasonic", "water_flow": "flow-yf-s201", "stock_weight": "load-cell",
    "float_switch": "float-switch",
}
SENSOR_STATE = {"invalid": "alert", "stale": "clock", "uncalibrated": "sliders-horizontal"}

# name: (colour, main glyph, corner badge or None). "team:x" is a sensor drawing, "lucide:x" a Lucide icon.
ICONS: dict[str, tuple[str, str, str | None]] = {
    "water-low": (WATER, "lucide:droplet", "arrow-down"),
    "float-switch-fault": (WATER, "team:float-switch", "alert"),
    "node-offline": (NETWORK, "lucide:wifi-off", None),
    "controller-offline": (NETWORK, "lucide:server-off", None),
    "controller-back": (OK, "lucide:server", "check"),
    "cloud-not-configured": (NETWORK, "lucide:cloud-cog", None),
    "cloud-unreachable": (NETWORK, "lucide:cloud-off", None),
    "zone-manual": (LIMIT, "lucide:hand", None),
    "max-run": (LIMIT, "lucide:timer-off", None),
    "out-of-range": (LIMIT, "lucide:gauge", "alert"),
    "actuator-fault": (LIMIT, "lucide:toggle-left", "alert"),
    "hardware-error": (LIMIT, "lucide:cpu", "alert"),
    "estop": (STOP, "lucide:octagon-x", None),
    "dose-stopped": (DOSE, "lucide:flask-conical-off", None),
    "load-cell-fault": (DOSE, "team:load-cell", "alert"),
    "stock-low": (DOSE, "lucide:flask-conical", "arrow-down"),
    "power-outage": (POWER, "lucide:zap-off", None),
    "undervoltage": (POWER, "lucide:zap", "arrow-down"),
    "stage-changed": (CROP, "lucide:sprout", None),
    "harvest-due": (CROP, "lucide:leafy-green", None),
    "alerts-batch": (CROP, "lucide:bell-ring", None),
    "alert-generic": (LIMIT, "lucide:triangle-alert", None),
    "sensor-generic": (SENSOR, "lucide:activity", None),
}
for _t, _f in SENSOR_SVG.items():
    for _state, _badge in SENSOR_STATE.items():
        ICONS[f"sensor-{_t.replace('_', '-')}-{_state}"] = (SENSOR, f"team:{_f}", _badge)
for _state, _badge in SENSOR_STATE.items():
    ICONS[f"sensor-generic-{_state}"] = (SENSOR, "lucide:activity", _badge)

# Small symbols for the corner badge (24 grid, stroked in the tile's colour on a white disc).
BADGE = {
    "alert": '<path d="M12 6v7"/><path d="M12 17.5h.01"/>',
    "clock": '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    "sliders-horizontal": '<path d="M5 8h14M5 16h14"/><circle cx="9" cy="8" r="2.2" fill="#fff"/><circle cx="15" cy="16" r="2.2" fill="#fff"/>',
    "arrow-down": '<path d="M12 5v13"/><path d="m6.5 12.5 5.5 5.5 5.5-5.5"/>',
    "check": '<path d="m5.5 12.5 4.5 4.5 8.5-9"/>',
}


def inner(svg: str) -> str:
    """The drawing inside an <svg>: comments, metadata and the outer tag removed."""
    svg = re.sub(r"<metadata[\s\S]*?</metadata>", "", svg)
    svg = re.sub(r"<!--[\s\S]*?-->", "", svg)
    return re.sub(r"^[\s\S]*?<svg[^>]*>|</svg>\s*$", "", svg.strip()).strip()


def glyph(spec: str) -> tuple[str, float]:
    kind, name = spec.split(":", 1)
    if kind == "team":
        return inner((SENSORS / f"{name}.svg").read_text(encoding="utf-8")), 1.6
    return inner((LUCIDE / f"{name}.svg").read_text(encoding="utf-8")), 1.9


def tile(colour: str, main: str, badge: str | None) -> str:
    bg = (gradient(0).replace('width="512" height="512" rx="0"', 'width="24" height="24" rx="5.3"')
          if colour == CROP else f'<rect width="24" height="24" rx="5.3" fill="{colour}"/>')
    body, sw = glyph(main)
    size, off = (13.0, 4.2) if badge else (14.0, 5.0)
    k = size / 24
    out = [bg, f'<g transform="translate({off} {off}) scale({k:.4f})" fill="none" stroke="#fff" '
               f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">{body}</g>']
    if badge:
        ink = GREEN_B if colour == CROP else colour
        out.append('<circle cx="18.2" cy="18.2" r="4.6" fill="#fff"/>')
        out.append(f'<g transform="translate(14.6 14.6) scale(0.3)" fill="none" stroke="{ink}" stroke-width="3.4" '
                   f'stroke-linecap="round" stroke-linejoin="round">{BADGE[badge]}</g>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">{"".join(out)}</svg>'


# ── drawing ─────────────────────────────────────────────────────────────────
class Painter:
    def __enter__(self):
        self._pw = sync_playwright().start()
        self._br = self._pw.chromium.launch()
        return self

    def __exit__(self, *exc):
        self._br.close()
        self._pw.stop()

    def png(self, svg: str, size: int, out: Path, bg: str | None = None) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        page = self._br.new_page(viewport={"width": size, "height": size})
        svg = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
        page.set_content(f'<html><body style="margin:0;background:{bg or "transparent"}">{svg}</body></html>')
        page.screenshot(path=str(out), omit_background=bg is None, clip={"x": 0, "y": 0, "width": size, "height": size})
        page.close()
        im = Image.open(out)
        im = im.convert("RGB") if bg else im.convert("RGBA")
        im.save(out, optimize=True)


def main() -> None:
    pub, assets = APP / "public", APP / "assets"
    # Favicon: the PWA icon itself, made small (64 px; browsers scale it for the tab).
    Image.open(pub / "icons/icon-512.png").convert("RGBA").resize((64, 64), Image.LANCZOS).save(
        pub / "favicon.png", optimize=True)
    with Painter() as p:
        p.png(svg512(leaf(0.84)), 96, pub / "icons/badge-96.png")
        for name, (colour, main, badge) in ICONS.items():
            p.png(tile(colour, main, badge), 192, pub / f"icons/alerts/{name}.png")
        # Android launcher icon (adaptive: foreground + background; icon-only for older Android).
        p.png(svg512(gradient() + leaf(ANY_LEAF)), 1024, assets / "icon-only.png", bg="#15803d")
        p.png(svg512(leaf(ANY_LEAF)), 1024, assets / "icon-foreground.png")
        p.png(svg512(gradient()), 1024, assets / "icon-background.png", bg="#15803d")
        # Splash: the app icon in the middle of the app's page colour (light and dark).
        for name, bg in (("splash.png", "#f8fafc"), ("splash-dark.png", "#0f172a")):
            icon = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="{bg}"/>'
                    f'<svg x="1110" y="1110" width="512" height="512" viewBox="0 0 512 512">{gradient(112)}{leaf(ANY_LEAF)}</svg></svg>')
            p.png(icon, 2732, assets / name, bg=bg)
    print(f"{len(ICONS)} alert icons, badge, favicon and Android sources written")


if __name__ == "__main__":
    main()
