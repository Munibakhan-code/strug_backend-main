import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: { findFirst: vi.fn() },
    strug_wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    wallet_transaction: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (cb) => cb({
      strug_wallet: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      wallet_transaction: { findFirst: vi.fn(), create: vi.fn() },
    })),
  },
}));

import prisma from '../../utils/prisma-client.js';
import {
  creditReferralForOrder,
  normalizeReferralCode,
  settleReferralThenRecruit,
  REFERRAL_TXN_WALLET_SOURCE,
  __private,
} from '../../utils/referral-settlement.js';

describe('referral-settlement (Phase S2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizeReferralCode trims and caps length', () => {
    expect(normalizeReferralCode('  STRUG-ABC  ')).toBe('STRUG-ABC');
    expect(normalizeReferralCode('')).toBe(null);
    expect(normalizeReferralCode(null)).toBe(null);
    expect(normalizeReferralCode('x'.repeat(100)).length).toBe(80);
  });

  it('credits code owner with source referral_txn and skips self-referral', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ user_id: 50 }); // owner of code
    prisma.wallet_transaction.findFirst.mockResolvedValue(null);
    prisma.strug_wallet.findUnique.mockResolvedValue({ user_id: 50, balance: 0 });
    prisma.$transaction.mockImplementation(async (cb) => {
      const t = {
        strug_wallet: { update: vi.fn() },
        wallet_transaction: { create: vi.fn() },
      };
      await cb(t);
      expect(t.strug_wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user_id: 50 }, data: { balance: { increment: 1 } } }),
      );
      expect(t.wallet_transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: 50,
            amount: 1,
            source: REFERRAL_TXN_WALLET_SOURCE,
            external_ref: 'referral_txn:food:9',
          }),
        }),
      );
    });

    const carved = await creditReferralForOrder({
      referralCode: 'STRUG-ABC',
      buyerUserId: 10,
      subtotal: 100,
      platformTake: 8,
      orderType: 'food',
      orderRef: 9,
    });
    expect(carved).toBe(1);
    expect(__private.REFERRAL_TXN_SHARE_RATE).toBe(0.01);
  });

  it('returns 0 on self-referral', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ user_id: 10 });
    const carved = await creditReferralForOrder({
      referralCode: 'ME',
      buyerUserId: 10,
      subtotal: 100,
      platformTake: 8,
      orderType: 'ride',
      orderRef: 1,
    });
    expect(carved).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('settleReferralThenRecruit reduces recruit budget by referral carve', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ user_id: 50 });
    prisma.wallet_transaction.findFirst.mockResolvedValue(null);
    prisma.strug_wallet.findUnique.mockResolvedValue({ user_id: 50, balance: 0 });
    prisma.$transaction.mockImplementation(async (cb) => {
      await cb({
        strug_wallet: { update: vi.fn() },
        wallet_transaction: { create: vi.fn() },
      });
    });

    const recruit = vi.fn(async () => undefined);
    const result = await settleReferralThenRecruit({
      referralCode: 'FRIEND',
      buyerUserId: 10,
      recruitParticipantUserIds: [99],
      subtotal: 100,
      platformTake: 8,
      orderType: 'product',
      orderRef: 3,
      creditRecruiterShares: recruit,
    });
    expect(result.referralCarve).toBe(1);
    expect(result.recruitBudget).toBe(7);
    expect(recruit).toHaveBeenCalledWith(
      expect.objectContaining({
        participantUserIds: [99],
        platformTake: 7,
        orderType: 'product',
        orderRef: 3,
      }),
    );
  });
});
