import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../utils/prisma-client.js';
import { creditRecruiterShares, __private } from '../../utils/recruiter-share.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    shared_ref_code: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    wallet_transaction: { findFirst: vi.fn(), create: vi.fn() },
    strug_wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// Map of recruited user_id -> recruiter user_id, driven per-test.
let RECRUITER_OF = {};

beforeEach(() => {
  vi.clearAllMocks();
  RECRUITER_OF = {};
  // shared_ref_code.findFirst({ where:{ shared_to }, include:{...ref_codeTouser}}) → recruiter user
  prisma.shared_ref_code.findFirst.mockImplementation(async ({ where }) => {
    const recruiterId = RECRUITER_OF[where.shared_to];
    if (!recruiterId) return null;
    return { share_id: 1, ref_code: 'STRUG-X', user_shared_ref_code_ref_codeTouser: { user_id: recruiterId } };
  });
  prisma.wallet_transaction.findFirst.mockResolvedValue(null); // not yet credited
  prisma.wallet_transaction.create.mockResolvedValue({});
  prisma.strug_wallet.findUnique.mockResolvedValue({ user_id: 0, balance: 0 }); // wallet exists
  prisma.strug_wallet.create.mockResolvedValue({});
  prisma.strug_wallet.update.mockResolvedValue({});
  // Standalone credit path wraps write() in $transaction — invoke it with the same mock.
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

describe('creditRecruiterShares', () => {
  it('credits the affiliate 2% of subtotal, capped below platform take', async () => {
    RECRUITER_OF = { 810: 222 }; // buyer 810 was recruited by 222
    await creditRecruiterShares({
      participantUserIds: [810, 999], subtotal: 100, platformTake: 8,
      orderType: 'food', orderRef: 123,
    });
    expect(prisma.strug_wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 222 }, data: { balance: { increment: 2 } } })
    );
    expect(prisma.wallet_transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        source: 'recruit',
        description: 'Affiliate share from food order · recruit:810',
        external_ref: 'recruiter:food:123:222',
      }) })
    );
  });

  it('caps the carve at the platform take (never exceeds it)', async () => {
    RECRUITER_OF = { 810: 222 };
    await creditRecruiterShares({
      participantUserIds: [810], subtotal: 1000, platformTake: 0.5,
      orderType: 'ride', orderRef: 7,
    });
    // 2% of 1000 = 20, but platformTake is only 0.5 → carve capped at 0.5
    expect(prisma.strug_wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 0.5 } } })
    );
  });

  it('does nothing when no participant has a recruiter', async () => {
    RECRUITER_OF = {}; // nobody recruited
    await creditRecruiterShares({
      participantUserIds: [810, 999], subtotal: 100, platformTake: 8,
      orderType: 'food', orderRef: 1,
    });
    expect(prisma.strug_wallet.update).not.toHaveBeenCalled();
    expect(prisma.wallet_transaction.create).not.toHaveBeenCalled();
  });

  it('is idempotent — skips when an external_ref credit already exists', async () => {
    RECRUITER_OF = { 810: 222 };
    prisma.wallet_transaction.findFirst.mockResolvedValue({ transaction_id: 5 }); // already credited
    await creditRecruiterShares({
      participantUserIds: [810], subtotal: 100, platformTake: 8,
      orderType: 'food', orderRef: 123,
    });
    expect(prisma.strug_wallet.update).not.toHaveBeenCalled();
    expect(prisma.wallet_transaction.create).not.toHaveBeenCalled();
  });

  it('does not let a recruiter earn off their own transaction (self-dealing)', async () => {
    RECRUITER_OF = { 810: 222 };
    // recruiter 222 is themselves a participant on this order → skip
    await creditRecruiterShares({
      participantUserIds: [810, 222], subtotal: 100, platformTake: 8,
      orderType: 'product', orderRef: 9,
    });
    expect(prisma.strug_wallet.update).not.toHaveBeenCalled();
  });

  it('pays a recruiter only once even if they recruited both participants', async () => {
    RECRUITER_OF = { 810: 222, 811: 222 }; // both buyer and seller recruited by 222
    await creditRecruiterShares({
      participantUserIds: [810, 811], subtotal: 200, platformTake: 50,
      orderType: 'booking', orderRef: 3,
    });
    expect(prisma.wallet_transaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.strug_wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 4 } } }) // 2% of 200, once
    );
  });

  it('never throws — a DB error is swallowed so settlement is unaffected', async () => {
    RECRUITER_OF = { 810: 222 };
    prisma.shared_ref_code.findFirst.mockRejectedValue(new Error('db down'));
    await expect(creditRecruiterShares({
      participantUserIds: [810], subtotal: 100, platformTake: 8,
      orderType: 'food', orderRef: 1,
    })).resolves.toBeUndefined();
  });

  it('ignores non-positive subtotal or platform take', async () => {
    RECRUITER_OF = { 810: 222 };
    await creditRecruiterShares({ participantUserIds: [810], subtotal: 0, platformTake: 8, orderType: 'food', orderRef: 1 });
    await creditRecruiterShares({ participantUserIds: [810], subtotal: 100, platformTake: 0, orderType: 'food', orderRef: 2 });
    expect(prisma.strug_wallet.update).not.toHaveBeenCalled();
  });

  it('rounds the carve to 2 decimals', () => {
    expect(__private.round2(1.005)).toBe(1.01);
    expect(__private.round2(0.1 + 0.2)).toBe(0.3);
  });
});
