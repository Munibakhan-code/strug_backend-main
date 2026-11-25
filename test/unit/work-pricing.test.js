import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveWorkRegion geocodes the job coords → country. Mock the maps boundary so the test
// is deterministic and never makes a network call.
vi.mock('../../utils/google-maps.js', () => ({
  getCountryFromCoords: vi.fn(),
}));

import { getCountryFromCoords } from '../../utils/google-maps.js';
import { computeWorkPricing, resolveWorkRegion } from '../../utils/work-pricing.js';

describe('computeWorkPricing — flat price', () => {
  it('Toronto $10 → 8% platform + 13% tax → worker keeps $7.90', () => {
    const r = computeWorkPricing({ price_type: 'flat', hirer_set_price: 10, taxRate: 0.13, currency: 'CAD' });
    expect(r).toEqual({
      total_charged: 10,
      platform_fee: 0.80,
      platform_fee_pct: 8,
      tax_amount: 1.30,
      tax_rate: 0.13,
      worker_payout: 7.90,
      currency: 'CAD',
    });
  });

  it('defaults currency to CAD and tax to 0 when omitted', () => {
    const r = computeWorkPricing({ price_type: 'flat', hirer_set_price: 100 });
    expect(r.currency).toBe('CAD');
    expect(r.tax_amount).toBe(0);
    expect(r.tax_rate).toBe(0);
    expect(r.platform_fee).toBe(8); // 100 * 0.08
    expect(r.worker_payout).toBe(92);
  });

  it('rounds each leg to 2 decimals independently', () => {
    const r = computeWorkPricing({ price_type: 'flat', hirer_set_price: 9.99, taxRate: 0.05 });
    expect(r.total_charged).toBe(9.99);
    expect(r.platform_fee).toBe(0.80); // round(0.7992)
    expect(r.tax_amount).toBe(0.50);   // round(0.4995)
    expect(r.worker_payout).toBe(8.69); // round(9.99 - 0.80 - 0.50)
  });
});

describe('computeWorkPricing — hourly', () => {
  it('multiplies hourly_rate × duration_hours for the total', () => {
    const r = computeWorkPricing({ price_type: 'hourly', hourly_rate: 20, duration_hours: 2.5, taxRate: 0.13 });
    expect(r.total_charged).toBe(50);
    expect(r.platform_fee).toBe(4);    // 50 * 0.08
    expect(r.tax_amount).toBe(6.5);    // 50 * 0.13
    expect(r.worker_payout).toBe(39.5);
  });

  it('treats missing hourly inputs as 0', () => {
    const r = computeWorkPricing({ price_type: 'hourly' });
    expect(r.total_charged).toBe(0);
    expect(r.worker_payout).toBe(0);
  });
});

describe('resolveWorkRegion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('geocodes coords → country → region data', async () => {
    getCountryFromCoords.mockResolvedValueOnce('Canada');
    await expect(resolveWorkRegion(43.65, -79.38)).resolves.toEqual({ tax: 0.13, currency: 'CAD' });
    expect(getCountryFromCoords).toHaveBeenCalledWith('43.65,-79.38');
  });

  it('returns the default region without geocoding when coords are missing', async () => {
    await expect(resolveWorkRegion(null, null)).resolves.toEqual({ tax: 0.05, currency: 'CAD' });
    expect(getCountryFromCoords).not.toHaveBeenCalled();
  });

  it('falls back to the default region when geocoding throws', async () => {
    getCountryFromCoords.mockRejectedValueOnce(new Error('maps down'));
    await expect(resolveWorkRegion(43.65, -79.38)).resolves.toEqual({ tax: 0.05, currency: 'CAD' });
  });
});
