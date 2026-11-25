import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RECRUITER_SETTLEMENT_COVERAGE,
  coverageStatuses,
  platformTakeFromPct,
  settleRecruiterShare,
  settleRecruiterShareFromPct,
  wiredVerticals,
  PLATFORM_FEE_PERCENTAGE,
} from '../../utils/recruiter-settlement.js';

vi.mock('../../utils/recruiter-share.js', () => ({
  creditRecruiterShares: vi.fn(async () => undefined),
}));

import { creditRecruiterShares } from '../../utils/recruiter-share.js';

describe('recruiter-settlement helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives platform take from percent of subtotal', () => {
    expect(platformTakeFromPct(100, 0.08)).toBe(8);
    expect(platformTakeFromPct(100, 0)).toBe(0);
    expect(platformTakeFromPct(0, 0.08)).toBe(0);
  });

  it('uses env PLATFORM_FEE_PERCENTAGE by default', () => {
    expect(platformTakeFromPct(200)).toBe(platformTakeFromPct(200, PLATFORM_FEE_PERCENTAGE));
  });

  it('settleRecruiterShare dedupes receive-side ids before forward', async () => {
    await settleRecruiterShare({
      orderType: 'freelance',
      orderRef: 9,
      participantUserIds: [1, 2, 1, null],
      subtotal: 50,
      platformTake: 4,
    });
    expect(creditRecruiterShares).toHaveBeenCalledWith({
      participantUserIds: [1, 2],
      subtotal: 50,
      platformTake: 4,
      orderType: 'freelance',
      orderRef: 9,
      tx: null,
    });
  });

  it('settleRecruiterShareFromPct computes platform take', async () => {
    await settleRecruiterShareFromPct({
      orderType: 'artist',
      orderRef: 3,
      participantUserIds: [10],
      subtotal: 100,
      feePct: 0.1,
    });
    expect(creditRecruiterShares).toHaveBeenCalledWith(
      expect.objectContaining({
        orderType: 'artist',
        orderRef: 3,
        subtotal: 100,
        platformTake: 10,
      }),
    );
  });
});

describe('RECRUITER_SETTLEMENT_COVERAGE matrix', () => {
  it('marks receive-side verticals as wired', () => {
    const wired = new Set(wiredVerticals());
    for (const v of [
      'food', 'product', 'booking', 'ride', 'work',
      'freelance', 'artist', 'celebrity', 'service',
      'raise_payout', 'live_gift', 'live_subscription',
    ]) {
      expect(wired.has(v), `${v} should be wired`).toBe(true);
    }
  });

  it('documents deferred / n/a paths so they are not silently forgotten', () => {
    const statuses = coverageStatuses();
    expect(statuses.dg).toBe('deferred');
    expect(statuses.donation_checkout).toBe('deferred');
    expect(statuses.courier).toBe('deferred');
    expect(statuses.ads_wallet).toBe('n/a');
    expect(RECRUITER_SETTLEMENT_COVERAGE.donation_checkout.reason).toMatch(/payout/i);
    expect(RECRUITER_SETTLEMENT_COVERAGE.dg.reason).toMatch(/buyer/i);
  });
});
