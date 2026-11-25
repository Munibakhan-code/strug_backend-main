import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../utils/prisma-client.js';
import { creditArtistBookingOnPaid } from '../../utils/artist-booking-settlement.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    $transaction: vi.fn(),
    artistBooking: { findUnique: vi.fn(), updateMany: vi.fn() },
    artistWallet: { upsert: vi.fn(), update: vi.fn() },
    artistWalletTransaction: { create: vi.fn() },
  },
}));

vi.mock('../../utils/referral-settlement.js', () => ({
  settleReferralThenRecruit: vi.fn(async () => ({ referralCarve: 0, recruitBudget: 20 })),
}));

vi.mock('../../utils/recruiter-share.js', () => ({
  creditRecruiterShares: vi.fn(async () => undefined),
}));

import { settleReferralThenRecruit } from '../../utils/referral-settlement.js';

describe('creditArtistBookingOnPaid recruiter hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('credits artist wallet once and settles referral then recruit', async () => {
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
    prisma.artistBooking.updateMany.mockResolvedValue({ count: 1 });
    prisma.artistWallet.upsert.mockResolvedValue({ id: 7 });
    prisma.artistWallet.update.mockResolvedValue({});
    prisma.artistWalletTransaction.create.mockResolvedValue({});
    prisma.artistBooking.findUnique.mockResolvedValue({
      id: 55,
      price: 200,
      referral_code: 'FRIEND',
      buyer_profile: { user_id: 11 },
      artist_profile: { user_id: 22 },
      artist_listing: { service_fee_pct: 10 },
    });

    const ok = await creditArtistBookingOnPaid({
      id: 55,
      payment_status: 'PENDING',
      artist_profile_id: 3,
      buyer_profile_id: 2,
      price: 200,
      referral_code: 'FRIEND',
    });

    expect(ok).toBe(true);
    expect(settleReferralThenRecruit).toHaveBeenCalledWith(
      expect.objectContaining({
        orderType: 'artist',
        orderRef: 55,
        referralCode: 'FRIEND',
        buyerUserId: 11,
        recruitParticipantUserIds: [22],
        subtotal: 200,
        platformTake: 20,
      }),
    );
  });

  it('does not settle when booking was already paid', async () => {
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
    prisma.artistBooking.updateMany.mockResolvedValue({ count: 0 });

    const ok = await creditArtistBookingOnPaid({
      id: 55,
      payment_status: 'PENDING',
      artist_profile_id: 3,
      buyer_profile_id: 2,
      price: 200,
    });

    expect(ok).toBe(false);
    expect(settleReferralThenRecruit).not.toHaveBeenCalled();
  });
});
