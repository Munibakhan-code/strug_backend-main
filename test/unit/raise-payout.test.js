import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, settleMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn() },
    strug_wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    projects: { findUnique: vi.fn() },
    donations: { aggregate: vi.fn() },
    campaign_payout: { aggregate: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    wallet_transaction: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  settleMock: vi.fn(async () => undefined),
}));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/recruiter-settlement.js', () => ({
  settleRecruiterShare: settleMock,
}));

import { campaignPayoutSummary, withdrawCampaign, markCampaignPayoutPaid } from '../../utils/raise-payout.js';

describe('raise payout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.strug_wallet.findUnique.mockResolvedValue({ wallet_id: 1, user_id: 77, balance: 0, currency: 'CAD' });
    prismaMock.projects.findUnique.mockResolvedValue({ project_id: 5, title: 'Solar Village' });
    prismaMock.user.findUnique.mockResolvedValue({ is_verified: true });
    prismaMock.$transaction.mockImplementation(async (fn) => fn({
      ...prismaMock,
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    }));
    prismaMock.campaign_payout.create.mockResolvedValue({ payout_id: 9, status: 'pending_review' });
    prismaMock.donations.aggregate.mockImplementation(async ({ where, _sum }) => {
      if (_sum.amount && where.payment_status === 'paid' && where.paid_at) return { _sum: { amount: 200 } };
      if (_sum.amount && where.payment_status === 'paid') return { _sum: { amount: 1000 } };
      if (_sum.refund_amount) return { _sum: { refund_amount: 100 } };
      return { _sum: { amount: 0, refund_amount: 0 } };
    });
    prismaMock.campaign_payout.aggregate.mockImplementation(async ({ where }) => {
      const key = JSON.stringify(where.status?.in || where.status || []);
      if (key.includes('pending_review') && key.includes('approved') && key.includes('paid') && key.includes('completed')) {
        return { _sum: { gross_amount: 300 } };
      }
      if (key.includes('paid') && key.includes('completed')) return { _sum: { gross_amount: 100 } };
      if (key.includes('pending_review') && key.includes('approved')) return { _sum: { gross_amount: 200 } };
      return { _sum: { gross_amount: 0 } };
    });
  });

  it('derives reserve, pending review, and available balance from donations and payouts', async () => {
    const summary = await campaignPayoutSummary(5);
    expect(summary).toMatchObject({
      raised: 900,
      withdrawn: 100,
      pending_review: 200,
      reserved: 200,
      available: 400,
    });
  });

  it('queues a verified creator withdrawal as pending review', async () => {
    const result = await withdrawCampaign(5, 77);
    expect(result.ok).toBe(true);
    expect(prismaMock.campaign_payout.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        project_id: 5,
        owner_user_id: 77,
        gross_amount: 400,
        status: 'pending_review',
      }),
    }));
  });

  it('blocks unverified creators from withdrawing', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ is_verified: false });
    const result = await withdrawCampaign(5, 77);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(403);
  });

  it('settles recruiter share from fee_amount when payout is marked paid', async () => {
    prismaMock.campaign_payout.findUnique.mockResolvedValue({
      payout_id: 42,
      owner_user_id: 77,
      project_id: 5,
      gross_amount: 400,
      fee_amount: 20,
      net_amount: 380,
      status: 'approved',
      reviewed_at: new Date(),
      approved_at: new Date(),
      projects: { title: 'Solar Village' },
    });
    prismaMock.wallet_transaction.findUnique.mockResolvedValue(null);
    prismaMock.strug_wallet.update.mockResolvedValue({});
    prismaMock.wallet_transaction.create.mockResolvedValue({});
    prismaMock.campaign_payout.update.mockResolvedValue({ payout_id: 42, status: 'paid' });

    const result = await markCampaignPayoutPaid(42);
    expect(result.ok).toBe(true);
    expect(settleMock).toHaveBeenCalledWith(expect.objectContaining({
      orderType: 'raise_payout',
      orderRef: 42,
      participantUserIds: [77],
      subtotal: 400,
      platformTake: 20,
    }));
  });
});
