import { describe, it, expect } from 'vitest';
import { catalogOfferExpiresAt, CATALOG_OFFER_MAX_MS } from '../../utils/work-catalog-offer.js';

describe('catalogOfferExpiresAt', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');

  it('gives at least 30 minutes to respond', () => {
    const start = new Date(now + 45 * 60 * 1000);
    const exp = catalogOfferExpiresAt(start, now);
    expect(exp.getTime()).toBe(now + 30 * 60 * 1000);
  });

  it('caps at 48 hours for far-future gigs', () => {
    const start = new Date(now + 10 * 24 * 3600 * 1000);
    const exp = catalogOfferExpiresAt(start, now);
    expect(exp.getTime()).toBe(now + CATALOG_OFFER_MAX_MS);
  });

  it('expires 15 minutes before a gig later today', () => {
    const start = new Date(now + 6 * 3600 * 1000);
    const exp = catalogOfferExpiresAt(start, now);
    expect(exp.getTime()).toBe(start.getTime() - 15 * 60 * 1000);
  });
});
