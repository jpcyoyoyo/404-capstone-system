import { describe, expect, it } from 'vitest';
import { METRIC_ICON } from './display';
import { SENSOR_ICON, SENSOR_TYPE_ICON, svgIcon } from './sensorIcons';

describe('sensor icons', () => {
  it('are data URLs ionicons parses without a fetch, coloured by currentColor', () => {
    for (const [name, url] of Object.entries(SENSOR_ICON)) {
      expect(url.startsWith('data:image/svg+xml;utf8,<svg'), name).toBe(true);
      expect(url, name).toContain('stroke="currentColor"');
      expect(url, name).not.toMatch(/<script|\son\w+=|<!--|\n|#/);
    }
  });

  it('covers every reading and every sensor type in the registry', () => {
    for (const [k, url] of Object.entries(METRIC_ICON)) expect(url.startsWith('data:image/svg+xml'), k).toBe(true);
    for (const t of ['temperature', 'humidity', 'soil_moisture', 'light', 'co2', 'ph', 'ec', 'water_temperature',
      'water_level', 'water_flow', 'stock_weight', 'float_switch']) expect(SENSOR_TYPE_ICON[t], t).toBeTruthy();
  });

  it('strips comments and line breaks', () => {
    expect(svgIcon('<svg>\n  <!-- note -->\n  <path d="M0 0"/>\n</svg>')).toBe('data:image/svg+xml;utf8,<svg> <path d="M0 0"/> </svg>');
  });

  it('drops a metadata block and stays small', () => {
    expect(svgIcon('<svg><path d="M0 0"/><metadata><c2pa:manifest>QUJD</c2pa:manifest></metadata></svg>'))
      .toBe('data:image/svg+xml;utf8,<svg><path d="M0 0"/></svg>');
    for (const [name, url] of Object.entries(SENSOR_ICON)) expect(url.length, name).toBeLessThan(1500);
  });
});
