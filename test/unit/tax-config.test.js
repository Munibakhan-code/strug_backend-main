import { describe, it, expect } from 'vitest';
import {
  getRegionData,
  REGIONAL_CONFIG,
  PLATFORM_FEE_PERCENTAGE,
} from '../../utils/tax-config.js';

describe('getRegionData', () => {
  // Single-currency launch: getRegionData keeps the per-country TAX rate but
  // always returns currency 'CAD' regardless of country.
  it('returns the configured tax for a known country, currency always CAD', () => {
    expect(getRegionData('Canada')).toEqual({ tax: 0.13, currency: 'CAD' });
    expect(getRegionData('Sri Lanka')).toEqual({ tax: 0.18, currency: 'CAD' });
    expect(getRegionData('United Kingdom')).toEqual({ tax: 0.20, currency: 'CAD' });
  });

  it('supports tax-free jurisdictions (rate 0), currency always CAD', () => {
    expect(getRegionData('United States')).toEqual({ tax: 0.0, currency: 'CAD' });
    expect(getRegionData('Qatar')).toEqual({ tax: 0.0, currency: 'CAD' });
  });

  it('falls back to the default tax for unknown / nullish input, currency CAD', () => {
    const fallback = { tax: 0.05, currency: 'CAD' };
    expect(getRegionData('Atlantis')).toEqual(fallback);
    expect(getRegionData(undefined)).toEqual(fallback);
    expect(getRegionData(null)).toEqual(fallback);
    expect(getRegionData('')).toEqual(fallback);
    // The raw config keeps its USD default; getRegionData overrides currency to CAD.
    expect(REGIONAL_CONFIG.default).toEqual({ tax: 0.05, currency: 'USD' });
  });

  it('is case-sensitive on country names (matches the schema exactly)', () => {
    // "canada" is not a key → default tax fallback. Callers must pass canonical names.
    expect(getRegionData('canada')).toEqual({ tax: 0.05, currency: 'CAD' });
  });
});

describe('PLATFORM_FEE_PERCENTAGE', () => {
  it('defaults to 0.08 (8%)', () => {
    // .env.test is absent in unit runs and PLATFORM_FEE defaults to "0.08".
    expect(PLATFORM_FEE_PERCENTAGE).toBe(0.08);
  });
});
