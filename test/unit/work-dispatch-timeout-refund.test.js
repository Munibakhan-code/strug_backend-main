import { beforeEach, describe, expect, it, vi } from 'vitest';

const { creditWorkWallet, notifyWork } = vi.hoisted(() => ({
  creditWorkWallet: vi.fn(async () => undefined),
  notifyWork: vi.fn(),
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    work_job: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    work_job_offer: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    worker_profile: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../utils/work-wallet.js', () => ({ creditWorkWallet }));
vi.mock('../../utils/work-notify.js', () => ({ notifyWork }));
vi.mock('../../utils/cron-email.js', () => ({ logCronError: vi.fn() }));

import prisma from '../../utils/prisma-client.js';
import { processExpiredWorkOffers } from '../../utils/work-dispatch.js';

function directOfferJob(overrides = {}) {
  return {
    work_job_id: 91,
    status: 'offered',
    hirer_id: 7,
    assigned_worker_id: 22,
    declined_worker_ids: [],
    hirer_set_price: 80,
    title: 'DJ set',
    offer_expires_at: new Date('2026-08-12T00:00:00.000Z'),
    ...overrides,
  };
}

describe('processExpiredWorkOffers — direct-offer refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.work_job.update.mockResolvedValue({});
    prisma.work_job.updateMany.mockResolvedValue({ count: 1 });
    prisma.work_job_offer.updateMany.mockResolvedValue({ count: 1 });
    prisma.work_job.findUnique.mockImplementation(async ({ where }) => ({
      work_job_id: where.work_job_id,
      status: 'offered',
    }));
  });

  it('credits the hirer when a direct offer times out', async () => {
    prisma.work_job.findMany.mockResolvedValue([directOfferJob()]);

    await processExpiredWorkOffers(null);

    expect(prisma.work_job.updateMany).toHaveBeenCalledWith({
      where: {
        work_job_id: 91,
        assigned_worker_id: 22,
        offer_expires_at: { lt: expect.any(Date) },
        status: { in: ['offered', 'searching'] },
      },
      data: { declined_worker_ids: [22], assigned_worker_id: null, offer_expires_at: null },
    });
    expect(creditWorkWallet).toHaveBeenCalledWith(
      7,
      80,
      'ondemand_direct_offer_refund',
      'Refund — direct offer #91 timed out',
      'direct_offer_refund:91',
    );
    expect(prisma.worker_profile.findMany).not.toHaveBeenCalled();
  });

  it('credits only once when processExpiredWorkOffers runs twice over the same row', async () => {
    prisma.work_job.findMany.mockResolvedValue([directOfferJob()]);
    let claimed = false;
    prisma.work_job.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });

    await processExpiredWorkOffers(null);
    await processExpiredWorkOffers(null);

    expect(creditWorkWallet).toHaveBeenCalledTimes(1);
    expect(creditWorkWallet).toHaveBeenCalledWith(
      7,
      80,
      'ondemand_direct_offer_refund',
      'Refund — direct offer #91 timed out',
      'direct_offer_refund:91',
    );
  });

  it('does not credit when another path already claimed the pending offer', async () => {
    prisma.work_job.findMany.mockResolvedValue([directOfferJob()]);
    prisma.work_job_offer.updateMany.mockResolvedValue({ count: 0 });

    await processExpiredWorkOffers(null);

    expect(creditWorkWallet).not.toHaveBeenCalled();
  });

  it('does not credit when the timed-out direct offer had no charge', async () => {
    prisma.work_job.findMany.mockResolvedValue([directOfferJob({ hirer_set_price: 0 })]);

    await processExpiredWorkOffers(null);

    expect(creditWorkWallet).not.toHaveBeenCalled();
  });

  it('does not use the direct-offer refund when a dispatched offer rolls to the next worker', async () => {
    const searching = directOfferJob({
      work_job_id: 44,
      status: 'searching',
      location_lat: 43.65,
      location_long: -79.38,
      category_id: 3,
    });
    prisma.work_job.findMany.mockResolvedValue([searching]);
    prisma.work_job.findUnique.mockResolvedValue({ ...searching, assigned_worker_id: null, offer_expires_at: null });
    prisma.worker_profile.findMany.mockResolvedValue([
      {
        worker_profile_id: 99,
        user_id: 50,
        current_lat: 43.65,
        current_long: -79.38,
        reliability_score: 100,
      },
    ]);
    prisma.work_job.update.mockResolvedValue({
      ...searching,
      assigned_worker_id: 99,
      offer_expires_at: new Date(),
      status: 'searching',
    });
    prisma.work_job_offer.create.mockResolvedValue({});

    await processExpiredWorkOffers(null);

    expect(creditWorkWallet).not.toHaveBeenCalled();
  });
});
