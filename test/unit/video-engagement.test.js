import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    video: {
      update: vi.fn(),
      findUnique: vi.fn()
    },
    video_view: {
      findUnique: vi.fn(),
      upsert: vi.fn()
    },
    social_profile: {
      findUnique: vi.fn()
    },
    content_impression: {
      upsert: vi.fn()
    },
    watch_history: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn()
    },
    video_analytics: {
      create: vi.fn()
    }
  }
}));

vi.mock('../../utils/redis-client.js', () => ({
  default: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    sadd: vi.fn()
  }
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 1, name: 'Owner User' };
    next();
  },
  optionalAuth: (req, res, next) => {
    req.user = { user_id: 1, name: 'Owner User' };
    next();
  }
}));

let app;
let prisma;
let redis;

describe('Video Engagement, History & Heartbeats API Tests', () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ default: prisma } = await import('../../utils/prisma-client.js'));
    ({ default: redis } = await import('../../utils/redis-client.js'));
    const { default: router } = await import('../../routes/video-engagement-routes.js');

    app = express();
    app.use(express.json());
    app.use('/video-engagement', router);
    // Surface route errors as JSON so a 500 failure is diagnosable in CI logs.
    app.use((err, _req, res, _next) => {
      res.status(500).json({ successful: false, message: err?.message || String(err) });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
  });

  it('should count view if not rate-limited and increment views_count', async () => {
    // The DB is the durable source of truth for views (#385/#368): the count is
    // incremented atomically in Postgres; Redis is only refreshed as a read cache.
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    prisma.video_view.findUnique.mockResolvedValue(null); // no recent view → count it
    prisma.video_view.upsert.mockResolvedValue({ id: 1 });
    prisma.video.update.mockResolvedValue({ views_count: 5 });
    prisma.social_profile.findUnique.mockResolvedValue({ profile_id: 200 });
    prisma.content_impression.upsert.mockResolvedValue({ profile_id: 200, content_id: 101 });

    const res = await request(app).post('/video-engagement/101/view');

    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(true);
    // The fresh count is returned so the watch page can reflect it live (#385/#368).
    expect(res.body.views_count).toBe(5);
    expect(prisma.video.update).toHaveBeenCalledWith({
      where: { video_id: 101 },
      data: { views_count: { increment: 1 } },
      select: { views_count: true },
    });
    // Redis is refreshed as a best-effort cache, never incremented as the source of truth.
    expect(redis.set).toHaveBeenCalledWith('video:101:views', 5);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('should NOT double-count a repeat view within the dedup window (Redis-independent)', async () => {
    redis.get.mockResolvedValue(null); // Redis down/absent → must fall back to DB dedup
    redis.set.mockResolvedValue('OK');
    prisma.video_view.findUnique.mockResolvedValue({ viewed_at: new Date() }); // recent view exists
    prisma.video.findUnique.mockResolvedValue({ views_count: 5 });

    const res = await request(app).post('/video-engagement/101/view');

    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(false);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('should prevent rapid ping heartbeats via Redis lock to stop watch-time fraud', async () => {
    redis.get.mockResolvedValue('1');

    const res = await request(app)
      .post('/video-engagement/101/ping')
      .send({ last_position: 120 });

    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Ping rate limit exceeded');
  });

  it('should save watch history position on valid ping and credit only the forward delta', async () => {
    redis.get.mockResolvedValue(null);
    prisma.video.findUnique.mockResolvedValue({ duration_sec: 600 });
    prisma.watch_history.findUnique.mockResolvedValue({ last_position: 140 }); // previous ping
    prisma.watch_history.upsert.mockResolvedValue({ video_id: 101 });
    prisma.video_analytics.create.mockResolvedValue({ id: 50 });

    const res = await request(app)
      .post('/video-engagement/101/ping')
      .send({ last_position: 150 }); // advanced 10s since last ping

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(prisma.watch_history.upsert).toHaveBeenCalled();
    // credited the 10s of real forward progress, not a flat amount. The ping also stamps
    // viewer_country + device_type (#146 audience analytics), which vary by geoip/UA env, so
    // assert the credited fields with objectContaining rather than an exact-shape match.
    expect(prisma.video_analytics.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ video_id: 101, watch_time_sec: 10 })
    });
  });

  it('should cap a fabricated forward jump to the per-ping window (anti time-inflation)', async () => {
    redis.get.mockResolvedValue(null);
    prisma.video.findUnique.mockResolvedValue({ duration_sec: 100000 });
    prisma.watch_history.findUnique.mockResolvedValue({ last_position: 0 });
    prisma.watch_history.upsert.mockResolvedValue({ video_id: 101 });
    prisma.video_analytics.create.mockResolvedValue({ id: 51 });

    const res = await request(app)
      .post('/video-engagement/101/ping')
      .send({ last_position: 9000 }); // scripted jump

    expect(res.status).toBe(200);
    expect(prisma.video_analytics.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ video_id: 101, watch_time_sec: 15 }) // capped, not 9000
    });
  });

  it('should reject a ping whose position exceeds the real video duration', async () => {
    redis.get.mockResolvedValue(null);
    prisma.video.findUnique.mockResolvedValue({ duration_sec: 120 });

    const res = await request(app)
      .post('/video-engagement/101/ping')
      .send({ last_position: 5000 });

    expect(res.status).toBe(400);
    expect(prisma.watch_history.upsert).not.toHaveBeenCalled();
  });

  it('should fetch user watch history sorted by recency successfully', async () => {
    const mockHistory = [
      {
        video_id: 101,
        last_position: 150,
        video: {
          title: 'Video 1',
          channel: {
            channel_id: 9,
            display_name: 'Creator 1',
            handle: 'creator1',
            profile_pic_url: 'https://cdn.test/creator1.jpg',
          },
        },
      },
    ];
    prisma.watch_history.findMany.mockResolvedValue(mockHistory);

    const res = await request(app).get('/video-engagement/history');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toEqual(mockHistory);
    // Library cards map channel.profile_pic_url onto the avatar — if the query drops it,
    // Watch History shows letter initials while Watch Later shows the real photo.
    expect(prisma.watch_history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          video: expect.objectContaining({
            include: expect.objectContaining({
              channel: expect.objectContaining({
                select: expect.objectContaining({
                  channel_id: true,
                  display_name: true,
                  handle: true,
                  profile_pic_url: true,
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('should fetch last saved resume playback position successfully', async () => {
    prisma.watch_history.findUnique.mockResolvedValue({ last_position: 240 });

    const res = await request(app).get('/video-engagement/101/resume');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.last_position).toBe(240);
  });
});