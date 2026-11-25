import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const refreshInterestProfile = vi.fn().mockResolvedValue({ topTokens: [], signalCount: 0 });

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    video_search_history: { create: vi.fn() },
    social_profile: { findUnique: vi.fn() },
    watch_history: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    video: { groupBy: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../../utils/redis-client.js', () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../utils/locale-geo.js', () => ({
  clientIp: () => '127.0.0.1',
  detectLocaleFromIp: async () => ({ country: null }),
}));

vi.mock('../../utils/recommendation-engine.js', () => ({
  refreshInterestProfile: (...args) => refreshInterestProfile(...args),
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { user_id: 42, profile_id: 9 };
    next();
  },
  optionalAuth: (_req, _res, next) => next(),
}));

let app;
let prisma;

describe('POST /video-discovery/search-log', () => {
  beforeAll(async () => {
    vi.resetModules();
    refreshInterestProfile.mockClear();
    ({ default: prisma } = await import('../../utils/prisma-client.js'));
    const { default: router } = await import('../../routes/video-discovery-routes.js');
    app = express();
    app.use(express.json());
    app.use('/video-discovery', router);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.video_search_history.create.mockResolvedValue({ search_id: 1 });
    prisma.social_profile.findUnique.mockResolvedValue({ profile_id: 9 });
    refreshInterestProfile.mockResolvedValue({ topTokens: ['chess'], signalCount: 1 });
  });

  it('persists the search and refreshes the interest profile for home-feed', async () => {
    const res = await request(app)
      .post('/video-discovery/search-log')
      .send({ query: 'chess openings', result_count: 0 })
      .expect(201);

    expect(res.body.successful).toBe(true);
    expect(prisma.video_search_history.create).toHaveBeenCalledWith({
      data: { user_id: 42, query: 'chess openings', result_count: 0 },
    });
    expect(prisma.social_profile.findUnique).toHaveBeenCalledWith({
      where: { user_id: 42 },
      select: { profile_id: true },
    });
    // Fire-and-forget — allow the microtask to run.
    await new Promise((r) => setImmediate(r));
    expect(refreshInterestProfile).toHaveBeenCalledWith(9, 42);
  });

  it('rejects empty queries', async () => {
    await request(app).post('/video-discovery/search-log').send({ query: '  ' }).expect(400);
    expect(prisma.video_search_history.create).not.toHaveBeenCalled();
    expect(refreshInterestProfile).not.toHaveBeenCalled();
  });

  it('still returns 201 when profile lookup misses (no refresh)', async () => {
    prisma.social_profile.findUnique.mockResolvedValue(null);
    await request(app)
      .post('/video-discovery/search-log')
      .send({ query: 'yoga', result_count: 3 })
      .expect(201);
    await new Promise((r) => setImmediate(r));
    expect(refreshInterestProfile).not.toHaveBeenCalled();
  });
});
