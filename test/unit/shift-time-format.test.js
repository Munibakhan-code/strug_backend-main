/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { formatShiftTimeForEmail } from '../../utils/shift-time-format.js';

describe('formatShiftTimeForEmail', () => {
  it('formats bare HH:MM:SS time strings without Invalid Date', () => {
    const out = formatShiftTimeForEmail('09:30:00');
    expect(out).not.toMatch(/Invalid Date/i);
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns N/A for empty', () => {
    expect(formatShiftTimeForEmail(null)).toBe('N/A');
    expect(formatShiftTimeForEmail('')).toBe('N/A');
  });

  it('formats Date instances', () => {
    const d = new Date(1970, 0, 1, 14, 5, 0);
    const out = formatShiftTimeForEmail(d);
    expect(out).not.toMatch(/Invalid Date/i);
  });

  it('falls back to string for unparsable values', () => {
    expect(formatShiftTimeForEmail('not-a-time')).toBe('not-a-time');
  });
});
