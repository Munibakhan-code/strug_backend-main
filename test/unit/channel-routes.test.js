import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import router from '../../routes/channel-routes.js';
import prisma from '../../utils/prisma-client.js';
import { checkHandleAvailability } from '../../utils/handle-availability.js';

vi.mock('../../utils/handle-availability.js', () => ({ checkHandleAvailability: vi.fn() }));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    channel: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    video_analytics: {
      aggregate: vi.fn()
    },
    board_task: {
      create: vi.fn()
    },
    revenue_share_log: {
      findMany: vi.fn(),
      aggregate: vi.fn()
    },
    live_subscription_payment: {
      findMany: vi.fn()
    },
    donations: {
      findMany: vi.fn()
    }
  }
}));

vi.mock('../../utils/redis-client.js', () => ({
  default: {
    set: vi.fn(),
    del: vi.fn()
  }
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 1, name: 'Test User' };
    next();
  },
  requireAdmin: (req, res, next) => next(),
}));

vi.mock('../../utils/analytics-buckets.js', () => ({
  RANGE_DAYS: { '7d': 7, '28d': 28, '365d': 365, 'lifetime': 365 },
  resolveRange: vi.fn((days) => {
    const now = new Date();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const prevEnd = new Date(start.getTime() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
    prevStart.setUTCHours(0, 0, 0, 0);
    return { start, prevStart, prevEnd };
  }),
  buildDateBuckets: vi.fn((start, days) => {
    const buckets = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      buckets.push(d.toISOString().slice(0, 10));
    }
    return buckets;
  }),
  pctChange: vi.fn((curr, prev) => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
  }),
  round2: vi.fn((n) => Math.round((n + Number.EPSILON) * 100) / 100),
  buildEarningsSeries: vi.fn(({ rows, prevRows, dateField, gross, net, start, days }) => {
    const timeseries = [];
    for (let i = 0; i < days; i++) {
      timeseries.push({ date: `2026-06-${(i + 1).toString().padStart(2, '0')}`, gross: 0, net: 0, count: 0 });
    }
    return {
      timeseries,
      summary: {
        gross: rows.reduce((s, r) => s + gross(r), 0),
        net: rows.reduce((s, r) => s + net(r), 0),
        count: rows.length,
        gross_change_pct: 0,
        net_change_pct: 0,
        count_change_pct: 0,
        avg_order_value: 0
      }
    };
  })
}));


const app = express();
app.use(express.json());
app.use('/channel', router);

describe('Channel registration and profile validation', () => {
  const valid = { handle: 'My.Channel', display_name: ' My Channel ' };
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.channel.findUnique.mockReset();
    prisma.channel.create.mockReset();
    prisma.channel.update.mockReset();
    prisma.channel.findUnique.mockResolvedValue(null);
    checkHandleAvailability.mockResolvedValue({ available: true });
    prisma.channel.create.mockResolvedValue({ channel_id: 7 });
    prisma.channel.update.mockResolvedValue({ channel_id: 7 });
  });
  it.each([
    {}, { handle: 123, display_name: 'Name' }, { handle: 'okay', display_name: {} },
    { handle: ' ', display_name: 'Name' }, { handle: 'okay', display_name: ' ' },
    { handle: 'bad!', display_name: 'Name' }, { handle: 'two words', display_name: 'Name' },
    { handle: 'a'.repeat(51), display_name: 'Name' },
    { handle: 'okay', display_name: 'a'.repeat(101) },
    { ...valid, description: [] },
  ])('rejects invalid registration input without a database write: %j', async body => {
    const res = await request(app).post('/channel').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHANNEL_INPUT');
    expect(prisma.channel.create).not.toHaveBeenCalled();
    expect(checkHandleAvailability).not.toHaveBeenCalled();
  });
  it('normalizes the handle and name and only writes allowed fields', async () => {
    const res = await request(app).post('/channel').send({ ...valid, user_id: 99, is_verified: true });
    expect(res.status).toBe(201);
    expect(checkHandleAvailability).toHaveBeenCalledWith('my.channel', 1);
    expect(prisma.channel.create).toHaveBeenCalledWith({ data: {user_id:1,handle:'my.channel',display_name:'My Channel',description:undefined} });
  });
  it('accepts schema boundary lengths', async () => {
    expect((await request(app).post('/channel').send({handle:'a'.repeat(50),display_name:'n'.repeat(100)})).status).toBe(201);
  });
  it('rejects a taken handle', async () => {
    checkHandleAvailability.mockResolvedValue({ available: false });
    expect((await request(app).post('/channel').send(valid)).status).toBe(400);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });
  it('does not create a second channel for an existing owner', async () => {
    prisma.channel.findUnique.mockResolvedValue({channel_id:7});
    const res=await request(app).post('/channel').send(valid);
    expect(res.body.message).toBe('You already have a channel.');
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });
  it('distinguishes a concurrent same-owner registration from a taken handle', async () => {
    prisma.channel.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({channel_id:7});
    prisma.channel.create.mockRejectedValue({code:'P2002'});
    const res=await request(app).post('/channel').send(valid);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CHANNEL_EXISTS');
  });
  it('reports a handle conflict when another owner wins the race', async () => {
    prisma.channel.create.mockRejectedValue({code:'P2002'});
    const res=await request(app).post('/channel').send(valid);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Handle is already taken.');
  });
  it.each([{handle:null}, {display_name:''}, {handle:'a'.repeat(51)}, {description:42}, {content_niche:[]}, {}])('validates partial updates: %j', async body => {
    const res=await request(app).put('/channel/update').send(body);
    expect(res.status).toBe(400);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
  it('allows clearing optional fields without changing required fields', async () => {
    const res=await request(app).put('/channel/update').send({description:null,content_niche:''});
    expect(res.status).toBe(200);
    expect(prisma.channel.update).toHaveBeenCalledWith({where:{user_id:1},data:{description:null,content_niche:'',updated_at:expect.any(Date)}});
  });
  it('keeps ownership-scoped missing-channel updates at 404', async () => {
    prisma.channel.update.mockRejectedValue({code:'P2025'});
    expect((await request(app).put('/channel/update').send({display_name:'Name'})).status).toBe(404);
  });
  it('rejects a taken handle on update without writing', async () => {
    checkHandleAvailability.mockResolvedValue({available:false});
    expect((await request(app).put('/channel/update').send({handle:'taken'})).status).toBe(400);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
  it('returns 400 for a database handle collision during update', async () => {
    prisma.channel.update.mockRejectedValue({code:'P2002'});
    expect((await request(app).put('/channel/update').send({handle:'taken'})).status).toBe(400);
  });
  it('does not convert a recovery database outage into a handle-taken response', async () => {
    prisma.channel.findUnique.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Database unavailable'));
    prisma.channel.create.mockRejectedValue({code:'P2002'});
    expect((await request(app).post('/channel').send(valid)).status).toBe(500);
  });
});

describe('Creator Monetization Status API Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.channel.findUnique).mockResolvedValue(null);
  });

  it('should return 404 if channel does not exist for monetization-status', async () => {
    const res = await request(app).get('/channel/monetization-status');
    expect(res.status).toBe(404);
    expect(res.body.successful).toBe(false);
    expect(res.body.message).toBe("Channel not found.");
  });

  it('should return eligibility false when creator has not met milestone goals', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      channel_id: 1,
      user_id: 1,
      handle: 'testcreator',
      is_verified: false,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      _count: { subscriptions: 500, videos: 2 },
      videos: [{ video_id: 101, status: 'safe' }, { video_id: 102, status: 'safe' }]
    });

    prisma.video_analytics.aggregate.mockResolvedValue({
      _sum: { watch_time_sec: 1800 * 3600 }
    });

    const res = await request(app).get('/channel/monetization-status');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.is_eligible).toBe(false);
    expect(res.body.data.current_subs).toBe(500);
    expect(res.body.data.current_watch_hours).toBe(1800.00);
    expect(res.body.data.required_subs).toBe(1000);
    expect(res.body.data.required_watch_hours).toBe(3000);
  });

  it('should return eligibility true and submit board task when milestones of 1000 subs and 3000 watch hours are met', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      channel_id: 1,
      user_id: 1,
      handle: 'testcreator',
      is_verified: false,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      _count: { subscriptions: 1200, videos: 2 },
      videos: [{ video_id: 101, status: 'safe' }, { video_id: 102, status: 'safe' }]
    });

    prisma.video_analytics.aggregate.mockResolvedValue({
      _sum: { watch_time_sec: 3200 * 3600 }
    });

    prisma.board_task.create.mockResolvedValue({ task_id: 500 });

    const res = await request(app).post('/channel/request-verification');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.message).toBe('Verification request submitted to Admin!');
    expect(prisma.board_task.create).toHaveBeenCalledWith({
      data: {
        title: 'Channel Verification Review: @testcreator',
        description: 'Creator Test User has requested channel verification. Subs: 1200, 365d Watch Hours: 3200.00',
        status: 'backlog',
        priority: 'medium',
        vertical: 'verification',
        assigner_id: 1,
        source_type: 'channel_verification',
        source_id: 1
      }
    });
  });

  it('should return 400 for request-verification if milestones are not met', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      channel_id: 1,
      user_id: 1,
      handle: 'testcreator',
      is_verified: false,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      _count: { subscriptions: 500, videos: 2 },
      videos: [{ video_id: 101, status: 'safe' }, { video_id: 102, status: 'safe' }]
    });

    prisma.video_analytics.aggregate.mockResolvedValue({
      _sum: { watch_time_sec: 1800 * 3600 }
    });

    const res = await request(app).post('/channel/request-verification');

    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
    expect(res.body.message).toBe("Milestones not met yet.");
    expect(prisma.board_task.create).not.toHaveBeenCalled();
  });

  it('should correctly calculate earnings breakdown', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      channel_id: 1,
      user_id: 1,
      handle: 'testcreator',
      videos: [{ video_id: 101, title: 'Ad Video 1', thumbnail_url: 'url1' }]
    });
    prisma.revenue_share_log.findMany.mockResolvedValue([
      { video_id: 101, total_earned: 100, creator_share: 70, created_at: new Date() }
    ]);
    prisma.revenue_share_log.aggregate.mockResolvedValue({
      _sum: { creator_share: 70 }
    });
    prisma.live_subscription_payment.findMany.mockResolvedValue([
      { creator_share: 20 }
    ]);
    prisma.donations.findMany.mockResolvedValue([
      { amount: 10 }
    ]);

    const res = await request(app).get('/channel/me/earnings/overview');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.breakdown).toEqual([
      { source: 'Ad Revenue', value: 70 },
      { source: 'Subscriptions', value: 20 },
      { source: 'Tips & Donations', value: 10 }
    ]);
    expect(res.body.data.lifetime_net).toBe(100);
  });

  it('should return empty earnings breakdown if no data', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      channel_id: 1,
      user_id: 1,
      handle: 'testcreator',
      videos: []
    });
    prisma.revenue_share_log.findMany.mockResolvedValue([]);
    prisma.revenue_share_log.aggregate.mockResolvedValue({
      _sum: { creator_share: 0 }
    });
    prisma.live_subscription_payment.findMany.mockResolvedValue([]);
    prisma.donations.findMany.mockResolvedValue([]);

    const res = await request(app).get('/channel/me/earnings/overview');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.breakdown).toEqual([
      { source: 'Ad Revenue', value: 0 },
      { source: 'Subscriptions', value: 0 },
      { source: 'Tips & Donations', value: 0 }
    ]);
    expect(res.body.data.lifetime_net).toBe(0);
  });
});
