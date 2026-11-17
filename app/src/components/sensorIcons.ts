/**
 * Icons drawn from the team's own sensors (photos in Evidence/Gate1), one SVG per part in
 * src/assets/sensors/. They are line drawings on currentColor, so they take the colour of their
 * text like the ionicons they replace, and they are passed to <IonIcon icon={…}> as data URLs.
 */
import bh1750 from '../assets/sensors/bh1750.svg?raw';
import dht22 from '../assets/sensors/dht22.svg?raw';
import dht22Humidity from '../assets/sensors/dht22-humidity.svg?raw';
import dht22Temperature from '../assets/sensors/dht22-temperature.svg?raw';
import ds18b20 from '../assets/sensors/ds18b20.svg?raw';
import floatSwitch from '../assets/sensors/float-switch.svg?raw';
import flow from '../assets/sensors/flow-yf-s201.svg?raw';
import loadCell from '../assets/sensors/load-cell.svg?raw';
import mhz19b from '../assets/sensors/mhz19b.svg?raw';
import phProbe from '../assets/sensors/ph-probe.svg?raw';
import soil from '../assets/sensors/soil-capacitive.svg?raw';
import tds from '../assets/sensors/tds-probe.svg?raw';
import ultrasonic from '../assets/sensors/ultrasonic.svg?raw';

/**
 * The `data:image/svg+xml;utf8,` form ionicons parses directly (no fetch). Comments, line breaks and
 * any <metadata> block (a content-credentials stamp can add one, about 8 KB) are dropped.
 */
export const svgIcon = (svg: string): string =>
  'data:image/svg+xml;utf8,' + svg
    .replace(/<metadata[\s\S]*?<\/metadata>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

export const SENSOR_ICON = {
  dht22: svgIcon(dht22),
  dht22_temperature: svgIcon(dht22Temperature),
  dht22_humidity: svgIcon(dht22Humidity),
  soil_capacitive: svgIcon(soil),
  bh1750: svgIcon(bh1750),
  mhz19b: svgIcon(mhz19b),
  ph_probe: svgIcon(phProbe),
  tds_probe: svgIcon(tds),
  ds18b20: svgIcon(ds18b20),
  ultrasonic: svgIcon(ultrasonic),
  flow: svgIcon(flow),
  load_cell: svgIcon(loadCell),
  float_switch: svgIcon(floatSwitch),
} as const;

/** By the registry's sensor `type` (contract/registry.yaml), for per-sensor lists. */
export const SENSOR_TYPE_ICON: Record<string, string> = {
  temperature: SENSOR_ICON.dht22_temperature,
  humidity: SENSOR_ICON.dht22_humidity,
  soil_moisture: SENSOR_ICON.soil_capacitive,
  light: SENSOR_ICON.bh1750,
  co2: SENSOR_ICON.mhz19b,
  ph: SENSOR_ICON.ph_probe,
  ec: SENSOR_ICON.tds_probe,
  water_temperature: SENSOR_ICON.ds18b20,
  water_level: SENSOR_ICON.ultrasonic,
  water_flow: SENSOR_ICON.flow,
  stock_weight: SENSOR_ICON.load_cell,
  float_switch: SENSOR_ICON.float_switch,
};
