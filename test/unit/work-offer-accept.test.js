import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    worker_profile: { findFirst: vi.fn(), findMany: vi.fn() },
    work_job: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    work_job_offer: { updateMany: vi.fn() },
    work_category: { findMany: vi.fn() },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json('Access denied');
    req.user = { user_id: 50 };
    next();
  },
}));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/work-dispatch.js', () => ({
  getIncomingWorkOffers: vi.fn(),
  reofferWorkAfterDecline: vi.fn(),
}));
vi.mock('../../utils/work-wallet.js', () => ({ creditWorkWallet: vi.fn() }));
vi.mock('../../utils/recruiter-share.js', () => ({ creditRecruiterShares: vi.fn() }));
vi.mock('../../utils/work-notify.js', () => ({ notifyWork: vi.fn() }));
vi.mock('../../utils/work-reliability.js', () => ({ rewardCompletion: vi.fn() }));
vi.mock('../../utils/analytics-buckets.js', () => ({
  RANGE_DAYS: 7,
  resolveRangeParam: vi.fn(),
  resolveRange: vi.fn(),
  buildEarningsSeries: vi.fn(),
  round2: (n) => n,
}));
vi.mock('../../services/chat-context-service.js', () => ({
  syncWorkJobChatMembers: vi.fn(async () => undefined),
}));

const router = (await import('../../routes/work-routes.js')).default;
const app = express();
app.use(express.json());
app.set('io', { to: vi.fn(() => ({ emit: vi.fn() })) });
app.use('/workers', router);

function liveOffer(overrides = {}) {
  return {
    work_job_id: 91,
    hirer_id: 7,
    status: 'offered',
    assigned_worker_id: 22,
    title: 'DJ set',
    offer_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

describe('PATCH /workers/offers/:jobId/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.worker_profile.findFirst.mockResolvedValue({ worker_profile_id: 22, user_id: 50 });
    prismaMock.work_job_offer.updateMany.mockResolvedValue({ count: 1 });
  });

  it('claims the offer with a guarded updateMany so a timeout cannot steal it', async () => {
    const job = liveOffer();
    prismaMock.work_job.findUnique.mockResolvedValue(job);
    prismaMock.work_job.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/workers/offers/91/accept')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(prismaMock.work_job.updateMany).toHaveBeenCalledWith({
      where: {
        work_job_id: 91,
        assigned_worker_id: 22,
        status: { in: ['offered', 'searching'] },
        offer_expires_at: { gt: expect.any(Date) },
      },
      data: { status: 'accepted', offer_expires_at: null, updated_at: expect.any(Date) },
    });
    expect(prismaMock.work_job.update).not.toHaveBeenCalled();
  });

  it('returns 409 when the claim loses to timeout', async () => {
    prismaMock.work_job.findUnique.mockResolvedValue(liveOffer());
    prismaMock.work_job.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/workers/offers/91/accept')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This offer is no longer available to you');
    expect(prismaMock.work_job_offer.updateMany).not.toHaveBeenCalled();
  });

  it('returns 409 expired when the offer deadline has passed', async () => {
    prismaMock.work_job.findUnique.mockResolvedValue(liveOffer({
      offer_expires_at: new Date(Date.now() - 1000),
    }));
    prismaMock.work_job.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/workers/offers/91/accept')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This offer has expired');
  });
});
