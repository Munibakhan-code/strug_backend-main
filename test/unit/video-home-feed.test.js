import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    video: { findMany: vi.fn() },
  },
}));

vi.mock('../../utils/recommendation-engine.js', () => ({
  getForYou: vi.fn(),
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 1, profile_id: 2 };
    next();
  },
  optionalAuth: (req, _res, next) => {
    if (req.headers['x-auth'] === '1') {
      req.user = { user_id: 1, profile_id: 2 };
    }
    next();
  },
}));

let app;
let getForYou;

describe('GET /video/home-feed cache headers', () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ getForYou } = await import('../../utils/recommendation-engine.js'));
    const { default: router } = await import('../../routes/video-routes.js');
    app = express();
    app.use(express.json());
    app.use('/video', router);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getForYou.mockResolvedValue({
      items: [{ video_id: 1, content_type: 'video' }],
      nextCursor: null,
      cold: false,
    });
  });

  it('marks authenticated home-feed responses private so personalisation is not shared', async () => {
    const res = await request(app).get('/video/home-feed').set('x-auth', '1').expect(200);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.body.data.cold_start).toBe(false);
  });

  it('keeps signed-out home-feed cacheable as public', async () => {
    const res = await request(app).get('/video/home-feed').expect(200);
    expect(res.headers['cache-control']).toMatch(/public/);
  });
});
