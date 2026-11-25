import { describe, it, expect } from 'vitest';
import {
  isValidTimeZone,
  startOfDayInTimeZone,
  dayRangeInTimeZone,
  DEFAULT_BUSINESS_TIMEZONE,
} from '../../utils/business-time.js';

// Format a UTC Date as the wall-clock time in a given zone for assertions.
// Some Node/ICU builds (notably Linux CI) emit hour "24" for midnight when
// hour12:false; normalize to "00" so assertions stay engine-agnostic.
function wallClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
}

describe('business-time timezone helpers', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('America/Toronto')).toBe(true);
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('resolves local midnight for a west-of-UTC zone (Toronto, EST)', () => {
    // 2026-01-15 09:00 UTC → still Jan 15 in Toronto (04:00 EST). Local midnight
    // of that day is 2026-01-15 05:00 UTC (UTC-5, no DST in January).
    const instant = new Date('2026-01-15T09:00:00.000Z');
    const start = startOfDayInTimeZone(instant, 'America/Toronto');
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('resolves local midnight for an east-of-UTC zone (Karachi, UTC+5)', () => {
    // 2026-07-25 21:00 UTC = 2026-07-26 02:00 in Karachi. Local midnight of
    // Jul 26 is 2026-07-25 19:00 UTC.
    const instant = new Date('2026-07-25T21:00:00.000Z');
    const start = startOfDayInTimeZone(instant, 'Asia/Karachi');
    expect(start.toISOString()).toBe('2026-07-25T19:00:00.000Z');
  });

  it('day window is a half-open range with the instant inside it', () => {
    const instant = new Date('2026-07-25T21:00:00.000Z'); // Jul 26 in Karachi
    const { start, end } = dayRangeInTimeZone(instant, 'Asia/Karachi');
    expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
    expect(end.getTime()).toBeGreaterThan(instant.getTime());
    // Both endpoints are local midnight (00:00) in the zone.
    expect(wallClock(start, 'Asia/Karachi').endsWith('00:00')).toBe(true);
    expect(wallClock(end, 'Asia/Karachi').endsWith('00:00')).toBe(true);
  });

  it('produces a ~24h window on a normal (non-DST) day', () => {
    const instant = new Date('2026-07-15T12:00:00.000Z');
    const { start, end } = dayRangeInTimeZone(instant, 'Asia/Karachi');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('spans 23h across the spring-forward DST transition (Toronto)', () => {
    // 2026-03-08 is the US/Canada spring-forward day (clocks skip 02:00→03:00),
    // so the local day is only 23 hours long.
    const instant = new Date('2026-03-08T12:00:00.000Z');
    const { start, end } = dayRangeInTimeZone(instant, 'America/Toronto');
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('falls back to the default zone for an invalid timezone', () => {
    const instant = new Date('2026-01-15T09:00:00.000Z');
    const bad = startOfDayInTimeZone(instant, 'Not/AZone');
    const good = startOfDayInTimeZone(instant, DEFAULT_BUSINESS_TIMEZONE);
    expect(bad.toISOString()).toBe(good.toISOString());
  });
});
