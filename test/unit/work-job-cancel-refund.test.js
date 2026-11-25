import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { prismaMock, creditWorkWallet, workerUserId, notifyWork } = vi.hoisted(() => ({
  creditWorkWallet: vi.fn(async () => undefined),
  workerUserId: vi.fn(async () => 99),
  notifyWork: vi.fn(),
  prismaMock: {
    work_job: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { user_id: 7 };
    next();
  },
}));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/work-wallet.js', () => ({
  debitWorkWallet: vi.fn(),
  creditWorkWallet,
  workerUserId,
}));
vi.mock('../../utils/work-dispatch.js', () => ({
  countAvailableWorkersInCategory: vi.fn(),
  dispatchWorkToNextWorker: vi.fn(),
  WORKER_OFFER_TIMEOUT_SEC: 45,
}));
vi.mock('../../utils/work-catalog-offer.js', () => ({ catalogOfferExpiresAt: vi.fn() }));
vi.mock('../../utils/work-pricing.js', () => ({
  computeWorkPricing: vi.fn(),
  resolveWorkRegion: vi.fn(),
}));
vi.mock('../../utils/work-notify.js', () => ({ notifyWork }));
vi.mock('../../utils/work-reliability.js', () => ({
  penalize: vi.fn(),
  rewardCompletion: vi.fn(),
}));
vi.mock('../../utils/analytics-buckets.js', () => ({
  RANGE_DAYS: 7,
  resolveRangeParam: vi.fn(),
  resolveRange: vi.fn(),
  buildEarningsSeries: vi.fn(),
}));

const router = (await import('../../routes/work-job-routes.js')).default;
const app = express();
app.use(express.json());
app.set('io', { to: vi.fn(() => ({ emit: vi.fn() })) });
app.use('/work-jobs', router);

function offeredJob(overrides = {}) {
  return {
    work_job_id: 91,
    hirer_id: 7,
    status: 'offered',
    hirer_set_price: 80,
    assigned_worker_id: 22,
    title: 'DJ set',
    scheduled_start: new Date(Date.now() + 48 * 3600000),
    ...overrides,
  };
}

describe('PATCH /work-jobs/:id/cancel — direct-offer refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.work_job.update.mockImplementation(async ({ data }) => ({
      work_job_id: 91,
      status: data.status,
      cancellation_reason: data.cancellation_reason,
    }));
  });

  it('credits the hirer with the timeout-path external ref when an offered job is cancelled', async () => {
    prismaMock.work_job.findUnique.mockResolvedValue(offeredJob());

    const res = await request(app)
      .patch('/work-jobs/91/cancel')
      .set('Authorization', 'Bearer test')
      .send({ reason: 'hirer dismissed' });

    expect(res.status).toBe(200);
    expect(res.body.refund).toBe(80);
    expect(res.body.note).toBe('full refund (offer not yet accepted)');
    expect(creditWorkWallet).toHaveBeenCalledWith(
      7,
      80,
      'ondemand_direct_offer_refund',
      'Refund — direct offer #91 cancelled',
      'direct_offer_refund:91',
    );
    expect(prismaMock.work_job.update).toHaveBeenCalledWith({
      where: { work_job_id: 91 },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
  });

  it('does not double-credit when timeout already wrote direct_offer_refund:id', async () => {
    prismaMock.work_job.findUnique.mockResolvedValue(offeredJob());
    creditWorkWallet.mockRejectedValueOnce({ code: 'P2002' });

    const res = await request(app)
      .patch('/work-jobs/91/cancel')
      .set('Authorization', 'Bearer test')
      .send({ reason: 'hirer dismissed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(creditWorkWallet).toHaveBeenCalledTimes(1);
  });

  it('still fully refunds a searching job without the direct-offer ledger key', async () => {
    prismaMock.work_job.findUnique.mockResolvedValue(offeredJob({ status: 'searching', work_job_id: 44 }));
    prismaMock.work_job.update.mockImplementation(async ({ data }) => ({
      work_job_id: 44,
      status: data.status,
    }));

    const res = await request(app)
      .patch('/work-jobs/44/cancel')
      .set('Authorization', 'Bearer test')
      .send({ reason: 'hirer dismissed' });

    expect(res.status).toBe(200);
    expect(res.body.refund).toBe(80);
    expect(creditWorkWallet).toHaveBeenCalledWith(
      7,
      80,
      'ondemand_work_refund',
      'Refund — booking #44 (full refund (no worker had accepted))',
      undefined,
    );
  });
});
