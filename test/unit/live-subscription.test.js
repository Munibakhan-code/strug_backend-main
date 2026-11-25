import { describe, it, expect } from 'vitest';
import {
  computeSplit,
  subscriptionPricing,
  SUB_PRICE_CENTS,
  SUB_CURRENCY,
  SUB_CREATOR_SHARE_RATIO,
} from '../../services/live-subscription.js';

describe('live subscription pricing config', () => {
  it('defaults to $4.99 CAD, 70% creator share', () => {
    // Env-overridable, but the committed defaults must match the agreed terms.
    expect(SUB_PRICE_CENTS).toBe(499);
    expect(SUB_CURRENCY).toBe('CAD');
    expect(SUB_CREATOR_SHARE_RATIO).toBe(0.7);
  });

  it('exposes pricing for the FE', () => {
    const p = subscriptionPricing();
    expect(p).toMatchObject({ price_cents: 499, currency: 'CAD', creator_share_ratio: 0.7 });
    expect(typeof p.enabled).toBe('boolean');
  });
});

describe('computeSplit', () => {
  it('splits $4.99 into 3.49 creator / 1.50 platform and sums back exactly', () => {
    const { creatorShare, platformShare } = computeSplit(499);
    expect(creatorShare).toBe(3.49); // round(4.99 * 0.70)
    expect(platformShare).toBe(1.5);
    expect(creatorShare + platformShare).toBeCloseTo(4.99, 2);
  });

  it('honours an explicit ratio and never loses cents to rounding', () => {
    const { creatorShare, platformShare } = computeSplit(999, 0.5);
    expect(creatorShare).toBe(5.0); // round(9.99 * 0.5) = 5.00 (round half up)
    expect(platformShare).toBe(4.99);
    expect(creatorShare + platformShare).toBeCloseTo(9.99, 2);
  });

  it('treats a zero / missing amount as no payout', () => {
    expect(computeSplit(0)).toEqual({ creatorShare: 0, platformShare: 0 });
    expect(computeSplit(undefined)).toEqual({ creatorShare: 0, platformShare: 0 });
  });

  it('gives everything to the creator at ratio 1 and nothing at ratio 0', () => {
    expect(computeSplit(499, 1)).toEqual({ creatorShare: 4.99, platformShare: 0 });
    expect(computeSplit(499, 0)).toEqual({ creatorShare: 0, platformShare: 4.99 });
  });
});
