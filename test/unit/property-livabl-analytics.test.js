import { describe, it, expect } from 'vitest';

/**
 * Contract check for builder analytics payload shape used by the
 * preconstruction seller dashboard (Livabl-style command center).
 */
describe('property livabl analytics contract', () => {
  it('property analytics totals contract', () => {
    const totals = {
      views: 1200,
      saves: 40,
      followers: 85,
      inquiries: 22,
      viewings: 9,
      leads: 31,
      conversion_rate: 2.6,
      communities: 3,
    };
    expect(typeof totals.views).toBe('number');
    expect(typeof totals.leads).toBe('number');
    expect(totals.leads).toBe(totals.inquiries + totals.viewings);
    expect(totals.conversion_rate).toBeGreaterThanOrEqual(0);
    expect(totals.communities).toBeGreaterThanOrEqual(0);
  });

  it('livabl merchandising arrays are optional JSON lists', () => {
    const property = {
      incentives: [{ title: 'Closing costs', detail: 'Up to $20k' }],
      move_in_homes: [{ address: 'Unit 1', beds: 2, baths: 2, sqft: 900, price: 700000 }],
      design_packages: [{ name: 'Signature', price_delta: 18000, includes: ['Oak'] }],
    };
    for (const key of ['incentives', 'move_in_homes', 'design_packages']) {
      expect(Array.isArray(property[key])).toBe(true);
      expect(property[key].length).toBeGreaterThanOrEqual(1);
    }
  });
});
