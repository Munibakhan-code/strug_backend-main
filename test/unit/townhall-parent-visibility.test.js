import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { prismaMock, authUser, blockedGraph } = vi.hoisted(() => ({
  prismaMock: {
    town_hall_post: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    social_profile: {
      findUnique: vi.fn(),
    },
    follower: {
      findFirst: vi.fn(),
    },
    user_tag: {
      findUnique: vi.fn(),
    },
  },
  authUser: { user_id: 42, profile_id: 420 },
  blockedGraph: { userIds: [], profileIds: [] },
}));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { ...authUser };
    next();
  },
}));

vi.mock('../../utils/platform-blocks.js', () => ({
  assertNoPlatformBlockBetweenUsers: vi.fn(),
  blockedGraphForUser: vi.fn(async () => ({
    userIds: [...blockedGraph.userIds],
    profileIds: [...blockedGraph.profileIds],
  })),
}));

vi.mock('../../utils/social-visibility.js', () => ({
  getExcludedTownHallAuthorUserIds: vi.fn(async () => []),
  getHiddenProfileIds: vi.fn(async () => []),
  notInIds: (field, ids) => (!ids?.length ? {} : { [field]: { notIn: ids } }),
}));

vi.mock('../../utils/redis-client.js', () => ({
  default: { status: 'end', get: vi.fn(), set: vi.fn(), del: vi.fn(), scan: vi.fn() },
}));

vi.mock('../../utils/azure-storage.js', () => ({
  uploadPublicBlob: vi.fn(),
  isTrustedBlobUrl: () => true,
  generateVideoReadSAS: (url) => url,
}));

vi.mock('../../workers/video-reconciliation.js', () => ({
  blobNameFromUrl: vi.fn(),
}));

vi.mock('../../utils/ads-delivery-engine.js', () => ({
  selectBestAd: vi.fn(),
  getOrCreateShadowPost: vi.fn(),
}));

vi.mock('../../middleware/social-rate-limiter.js', () => ({
  socialRateLimiter: (_req, _res, next) => next(),
  engagementRateLimiter: (_req, _res, next) => next(),
  uploadRateLimiter: (_req, _res, next) => next(),
}));

vi.mock('../../middleware/profanity-filter.js', () => ({
  profanityFilter: (_req, _res, next) => next(),
}));

vi.mock('../../utils/validate-mime.js', () => ({
  validateMime: vi.fn(),
  ALLOWED_IMAGE_TYPES: [],
  ALLOWED_VIDEO_TYPES: [],
  ALLOWED_MEDIA_TYPES: [],
}));

vi.mock('../../utils/media-processor.js', () => ({
  optimizeImage: vi.fn(),
}));

vi.mock('../../utils/azure-queue.js', () => ({
  pushToVideoQueue: vi.fn(),
  enqueueTownhallImport: vi.fn(),
}));

vi.mock('../../utils/twitter-source.js', () => ({
  normalizeTwitterSourceUrl: vi.fn(),
}));

vi.mock('../../services/notify.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../services/townhall-recommender.js', () => ({
  getUserPersonalizationContext: vi.fn(),
  scoreCandidate: vi.fn(),
  diversifyByAuthor: vi.fn(),
  makeSeededRandom: vi.fn(),
  utcDayBucket: vi.fn(),
}));

const router = (await import('../../routes/town-hall-routes.js')).default;
const app = express();
app.use(express.json());
app.use('/town-hall', router);

function visibleParent(overrides = {}) {
  return {
    post_id: 10,
    user_id: 99,
    is_banned: false,
    scheduled_at: null,
    ...overrides,
  };
}

function childPost(overrides = {}) {
  return {
    post_id: 11,
    parent_id: 10,
    user: { user_id: 5, name: 'Sam', social_profiles: { handle: 'sam' } },
    ...overrides,
  };
}

describe('Town Hall parent visibility (#1200)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authUser.user_id = 42;
    authUser.profile_id = 420;
    blockedGraph.userIds = [];
    blockedGraph.profileIds = [];
    prismaMock.town_hall_post.findUnique.mockResolvedValue(visibleParent());
    prismaMock.town_hall_post.findMany.mockResolvedValue([childPost()]);
    prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 7, is_private: false });
    prismaMock.follower.findFirst.mockResolvedValue(null);
  });

  describe('GET /town-hall/:id/replies', () => {
    it('404s when the parent does not exist', async () => {
      prismaMock.town_hall_post.findUnique.mockResolvedValue(null);

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Post not found');
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('404s replies on a banned parent', async () => {
      prismaMock.town_hall_post.findUnique.mockResolvedValue(visibleParent({ is_banned: true }));

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('404s replies on a future-scheduled parent', async () => {
      prismaMock.town_hall_post.findUnique.mockResolvedValue(
        visibleParent({ scheduled_at: new Date(Date.now() + 60_000) }),
      );

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('404s replies on a private parent the viewer does not follow', async () => {
      prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 7, is_private: true });
      prismaMock.follower.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('404s replies when the parent author is blocked', async () => {
      blockedGraph.userIds = [99];

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('lets the author list replies on their own scheduled post', async () => {
      authUser.user_id = 99;
      prismaMock.town_hall_post.findUnique.mockResolvedValue(
        visibleParent({ scheduled_at: new Date(Date.now() + 60_000) }),
      );

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(prismaMock.town_hall_post.findMany).toHaveBeenCalled();
    });

    it('lets a follower list replies on a private parent', async () => {
      prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 7, is_private: true });
      prismaMock.follower.findFirst.mockResolvedValue({ id: 1 });

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(200);
      expect(res.body[0].post_id).toBe(11);
      expect(prismaMock.follower.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'accepted' }),
        }),
      );
    });

    it('does not treat a pending follow request as access to a private parent', async () => {
      prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 7, is_private: true });
      prismaMock.follower.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(404);
    });

    it('lists replies when the parent is visible', async () => {
      const res = await request(app).get('/town-hall/10/replies');

      expect(res.status).toBe(200);
      expect(res.body[0].post_id).toBe(11);
      expect(prismaMock.town_hall_post.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { post_id: 10 } }),
      );
    });

    it('400s on a non-numeric parent id', async () => {
      const res = await request(app).get('/town-hall/abc/replies');

      expect(res.status).toBe(400);
      expect(prismaMock.town_hall_post.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('GET /town-hall/:id/quotes', () => {
    it('404s quotes of a banned parent', async () => {
      prismaMock.town_hall_post.findUnique.mockResolvedValue(visibleParent({ is_banned: true }));

      const res = await request(app).get('/town-hall/10/quotes');

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Post not found');
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('404s quotes of a hidden private parent', async () => {
      prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 7, is_private: true });

      const res = await request(app).get('/town-hall/10/quotes');

      expect(res.status).toBe(404);
      expect(prismaMock.town_hall_post.findMany).not.toHaveBeenCalled();
    });

    it('lists quotes when the parent is visible', async () => {
      prismaMock.town_hall_post.findMany.mockResolvedValue([
        childPost({ post_id: 22, quote_post_id: 10 }),
      ]);

      const res = await request(app).get('/town-hall/10/quotes');

      expect(res.status).toBe(200);
      expect(res.body[0].post_id).toBe(22);
      expect(prismaMock.town_hall_post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ quote_post_id: 10, is_banned: false }),
        }),
      );
    });
  });
});
