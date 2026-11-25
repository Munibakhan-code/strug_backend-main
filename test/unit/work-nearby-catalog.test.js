import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    work_category: { findMany: vi.fn() },
    worker_profile: { findMany: vi.fn() },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json('Access denied');
    req.user = { user_id: 42 };
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

const router = (await import('../../routes/work-routes.js')).default;
const app = express();
app.use(express.json());
app.use('/workers', router);

function catalogWorker(id, overrides = {}) {
  return {
    worker_profile_id: id,
    current_lat: 43.65,
    current_long: -79.38,
    rating: 4.8,
    bio: 'Toronto DJ',
    is_available: false,
    user: { name: 'Alex Rivera', channel: { profile_pic_url: null } },
    worker_category: [{
      work_category_id: 9,
      price_type: 'hourly',
      hourly_rate: 120,
      flat_rate: null,
      worker_package: [],
      work_category: { work_category_id: 9, name: 'DJ', slug: 'dj' },
    }],
    ...overrides,
  };
}

describe('GET /workers/nearby catalog browse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.work_category.findMany.mockResolvedValue([{ work_category_id: 9 }]);
    prismaMock.worker_profile.findMany.mockResolvedValue([catalogWorker(1)]);
  });

  it('rejects anonymous catalog=1 browse', async () => {
    const res = await request(app).get('/workers/nearby?catalog=1');
    expect(res.status).toBe(401);
    expect(prismaMock.worker_profile.findMany).not.toHaveBeenCalled();
  });

  it('keeps on-demand nearby public when lat/lng are present', async () => {
    const res = await request(app).get('/workers/nearby?lat=43.65&lng=-79.38');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1,
      initial: 'A',
      rating: 4.8,
    }));
    expect(res.body[0].name).toBeUndefined();
    expect(res.body[0].bio).toBeUndefined();
  });

  it('returns name/bio for authenticated catalog browse and caps the query', async () => {
    const res = await request(app)
      .get('/workers/nearby?catalog=1&category_slug=dj')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(prismaMock.worker_profile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 24 }),
    );
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1,
      name: 'Alex Rivera',
      bio: 'Toronto DJ',
      hourly_rate: 120,
    }));
  });

  it('fuzzes longitude in catalog mode even without a request center', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const res = await request(app)
      .get('/workers/nearby?catalog=1&category_slug=dj')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body[0].lng).not.toBe(-79.38);
    expect(res.body[0].lat).not.toBe(43.65);
    Date.now.mockRestore();
  });

  it('requires category_slug in catalog mode', async () => {
    const res = await request(app)
      .get('/workers/nearby?catalog=1')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('category_slug is required');
    expect(prismaMock.worker_profile.findMany).not.toHaveBeenCalled();
  });
});
