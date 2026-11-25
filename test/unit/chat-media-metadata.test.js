import { describe, expect, it } from 'vitest';
import { sanitizeWaveformPeaks, sanitizeMediaCaption } from '../../utils/chat-media-metadata.js';

describe('sanitizeWaveformPeaks', () => {
  it('keeps valid peaks in 0–1 range', () => {
    expect(sanitizeWaveformPeaks([0, 0.5, 1])).toEqual([0, 0.5, 1]);
  });

  it('returns null for empty or invalid input', () => {
    expect(sanitizeWaveformPeaks(null)).toBeNull();
    expect(sanitizeWaveformPeaks([])).toBeNull();
    expect(sanitizeWaveformPeaks(['x', -1, 2])).toBeNull();
  });

  it('caps at 64 bars', () => {
    const peaks = Array.from({ length: 80 }, (_, i) => i / 100);
    expect(sanitizeWaveformPeaks(peaks)?.length).toBe(64);
  });
});

describe('sanitizeMediaCaption', () => {
  it('trims whitespace', () => {
    expect(sanitizeMediaCaption('  hello  ')).toBe('hello');
  });

  it('returns null for empty, whitespace-only, or non-string input', () => {
    expect(sanitizeMediaCaption('')).toBeNull();
    expect(sanitizeMediaCaption('   ')).toBeNull();
    expect(sanitizeMediaCaption(null)).toBeNull();
    expect(sanitizeMediaCaption(undefined)).toBeNull();
    expect(sanitizeMediaCaption(42)).toBeNull();
  });

  it('caps length at 2000 characters', () => {
    const long = 'a'.repeat(2500);
    expect(sanitizeMediaCaption(long)?.length).toBe(2000);
  });
});
