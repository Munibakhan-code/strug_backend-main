import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    product_listing: { findMany: vi.fn() },
    product_order: { count: vi.fn() },
    live_session: { count: vi.fn() },
    video_view: { count: vi.fn() },
    dg_content: { findMany: vi.fn() },
    saved_item: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { user_id: 7 };
    next();
  },
  optionalAuth: (req, _res, next) => {
    if (req.headers.authorization) req.user = { user_id: 7 };
    next();
  },
}));

const prisma = (await import('../../utils/prisma-client.js')).default;
const router = (await import('../../routes/platform-public-routes.js')).default;

const app = express();
app.use(express.json());
app.use('/platform', router);
app.use((err, _req, res, _next) => {
  res.status(500).json({ successful: false, message: err?.message || 'error' });
});

describe('GET /platform/today', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns live aggregates and server-built tips', async () => {
    prisma.product_listing.findMany.mockResolvedValue([{ seller_id: 1 }, { seller_id: 2 }]);
    prisma.product_order.count.mockResolvedValue(7);
    prisma.live_session.count.mockResolvedValue(1);
    prisma.video_view.count.mockResolvedValue(42);

    const res = await request(app).get('/platform/today');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toEqual(expect.objectContaining({
      active_sellers: 2,
      orders_today: 7,
      live_streams: 1,
      videos_watched_today: 42,
    }));
    expect(Array.isArray(res.body.data.tips)).toBe(true);
    expect(res.body.data.tips[0].text).toMatch(/2 sellers/i);
    expect(prisma.product_order.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ispaid: true }),
    }));
    expect(prisma.product_listing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        seller_id: { not: null },
        seller: {
          OR: [
            { storeProfile: { is: null } },
            { storeProfile: { is_active: true } },
          ],
        },
      }),
      distinct: ['seller_id'],
    }));
  });

  it('excludes deactivated stores from the active_sellers query (browse parity)', async () => {
    prisma.product_listing.findMany.mockResolvedValue([{ seller_id: 9 }]);
    prisma.product_order.count.mockResolvedValue(0);
    prisma.live_session.count.mockResolvedValue(0);
    prisma.video_view.count.mockResolvedValue(0);

    await request(app).get('/platform/today');

    const sellerWhere = prisma.product_listing.findMany.mock.calls[0][0].where;
    expect(sellerWhere.seller.OR).toEqual([
      { storeProfile: { is: null } },
      { storeProfile: { is_active: true } },
    ]);
    expect(JSON.stringify(sellerWhere)).not.toMatch(/"is_active":false/);
  });

  it('returns 500 when a count query fails', async () => {
    prisma.product_listing.findMany.mockRejectedValue(new Error('db down'));
    prisma.product_order.count.mockResolvedValue(0);
    prisma.live_session.count.mockResolvedValue(0);
    prisma.video_view.count.mockResolvedValue(0);

    const res = await request(app).get('/platform/today');
    expect(res.status).toBe(500);
  });

  it('does not require authentication', async () => {
    prisma.product_listing.findMany.mockResolvedValue([]);
    prisma.product_order.count.mockResolvedValue(0);
    prisma.live_session.count.mockResolvedValue(0);
    prisma.video_view.count.mockResolvedValue(0);

    const res = await request(app).get('/platform/today');
    expect(res.status).toBe(200);
    expect(res.body.data.active_sellers).toBe(0);
  });
});

describe('GET /platform/profile-content', () => {
  it('returns curated sidebar payload', async () => {
    const res = await request(app).get('/platform/profile-content');
    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.whats_new.length).toBeGreaterThan(0);
    expect(res.body.data.poll.options.length).toBe(2);
  });
});

describe('GET /platform/book-of-day', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers a catalog book when Books inventory exists', async () => {
    prisma.dg_content.findMany.mockResolvedValue([
      {
        content_id: 9,
        content_title: 'Catalog Book',
        author: 'Author',
        content_description: 'Hello',
        cover_img_url: null,
      },
    ]);
    const res = await request(app).get('/platform/book-of-day');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      id: '9',
      source: 'catalog',
      title: 'Catalog Book',
      savable: true,
    }));
  });

  it('falls back to curated when catalog is empty', async () => {
    prisma.dg_content.findMany.mockResolvedValue([]);
    const res = await request(app).get('/platform/book-of-day');
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('curated');
    expect(res.body.data.id).toMatch(/^curated:/);
    expect(res.body.data.savable).toBe(true);
  });
});

describe('profile poll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET returns tallies and my_vote when authorized', async () => {
    prisma.saved_item.findMany.mockResolvedValue([
      { user_id: 7, meta: { option: 'Videos & Live' } },
      { user_id: 8, meta: { option: 'Shopping & Food' } },
    ]);
    const res = await request(app)
      .get('/platform/profile-poll')
      .set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(res.body.data.tallies['Videos & Live']).toBe(1);
    expect(res.body.data.my_vote).toBe('Videos & Live');
  });

  it('POST rejects unknown options before write', async () => {
    const res = await request(app)
      .post('/platform/profile-poll/vote')
      .send({ option: 'Not a real option' });
    expect(res.status).toBe(400);
    expect(prisma.saved_item.create).not.toHaveBeenCalled();
    expect(prisma.saved_item.update).not.toHaveBeenCalled();
  });

  it('POST creates a vote when none exists', async () => {
    prisma.saved_item.findUnique.mockResolvedValue(null);
    prisma.saved_item.create.mockResolvedValue({});
    const res = await request(app)
      .post('/platform/profile-poll/vote')
      .send({ option: 'Videos & Live' });
    expect(res.status).toBe(200);
    expect(prisma.saved_item.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entity_type: 'profile_poll',
        meta: { option: 'Videos & Live' },
      }),
    }));
  });
});

describe('sidebar state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET returns defaults when no row', async () => {
    prisma.saved_item.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/platform/me/sidebar-state');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      sticky_text: '',
      goals: [false, false, false],
      challenge_done_date: null,
    });
  });

  it('PUT normalizes and persists state', async () => {
    prisma.saved_item.findUnique.mockResolvedValue(null);
    prisma.saved_item.create.mockResolvedValue({});
    const res = await request(app)
      .put('/platform/me/sidebar-state')
      .send({ sticky_text: 'hello', goals: [true], challenge_done_date: 'Sat Sep 05 2026' });
    expect(res.status).toBe(200);
    expect(res.body.data.goals).toEqual([true, false, false]);
    expect(res.body.data.sticky_text).toBe('hello');
    expect(prisma.saved_item.create).toHaveBeenCalled();
  });
});

describe('GET /platform/weather', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.clearAllMocks();
  });

  it('rejects invalid coordinates', async () => {
    const res = await request(app).get('/platform/weather?lat=999&lon=0');
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps open-meteo current conditions', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 21.4,
          weather_code: 0,
          time: '2026-09-05T12:00',
        },
      }),
    });
    const res = await request(app).get('/platform/weather');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      temperature_c: 21,
      condition: 'Clear',
      source: 'open-meteo',
    }));
  });
});
