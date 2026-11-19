import { describe, expect, it } from 'vitest';
import { periodRange, rawSizeMb, ymd } from './exportPeriod';

describe('export periods', () => {
  const now = new Date(2026, 10, 19, 9, 30);          // 19 Nov 2026, 09:30 on the device
  it('today runs from local midnight to now', () => {
    const [a, b] = periodRange('today', { from: '', to: '' }, now);
    expect(a).toEqual(new Date(2026, 10, 19, 0, 0)); expect(b).toEqual(now);
  });
  it('rolling periods end now', () => {
    const [a, b] = periodRange('7d', { from: '', to: '' }, now);
    expect(b.getTime() - a.getTime()).toBe(7 * 86_400_000);
  });
  it('custom dates include the whole last day', () => {
    const [a, b] = periodRange('custom', { from: '2026-11-17', to: '2026-11-18' }, now);
    expect(a).toEqual(new Date(2026, 10, 17)); expect(b).toEqual(new Date(2026, 10, 19));
    expect(ymd(a)).toBe('2026-11-17');
  });
  it('estimates the size of every reading', () => {
    expect(rawSizeMb(25, 7 * 86_400_000)).toBe(37.8);   // about what 25 sensors at 30 s give in a week
    expect(rawSizeMb(0, 86_400_000)).toBe(0);
  });
});
