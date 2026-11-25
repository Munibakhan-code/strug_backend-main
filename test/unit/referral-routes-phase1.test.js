import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import router from '../../routes/referral-routes.js';
import prisma from '../../utils/prisma-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    shared_ref_code: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
    recruit_invite: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    wallet_transaction: { findMany: vi.fn() },
    strug_wallet: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 100 };
    next();
  },
}));

vi.mock('../../utils/rate-limiter.js', () => ({
  checkRateLimit: vi.fn(async () => false),
}));

vi.mock('../../services/notify.js', () => ({
  default: vi.fn(),
}));

import { checkRateLimit } from '../../utils/rate-limiter.js';
import notify from '../../services/notify.js';

const app = express();
app.use(express.json());
app.set('io', {});
app.use('/referral', router);

describe('GET /referral/my-recruits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty list when the user has no ref code', async () => {
    prisma.user.findUnique.mockResolvedValue({ ref_code: null });
    const res = await request(app).get('/referral/my-recruits');
    expect(res.status).toBe(200);
    expect(res.body.data.recruits).toEqual([]);
    expect(res.body.data.summary.total).toBe(0);
  });

  it('lists recruits with earnings attribution and period filter', async () => {
    prisma.user.findUnique.mockResolvedValue({ ref_code: 'STRUG-ME' });
    prisma.shared_ref_code.findMany.mockResolvedValue([
      {
        share_id: 1,
        shared_to: 501,
        created_at: new Date(),
        user_shared_ref_code_shared_toTouser: { user_id: 501, username: 'cara', name: 'Cara' },
        checkouts: [{ total: 50 }],
      },
      {
        share_id: 2,
        shared_to: 502,
        created_at: new Date('2020-01-01T00:00:00.000Z'),
        user_shared_ref_code_shared_toTouser: { user_id: 502, username: 'dan', name: 'Dan' },
        checkouts: [],
      },
    ]);
    prisma.wallet_transaction.findMany.mockResolvedValue([
      { amount: 1.5, description: 'Affiliate share from food order · recruit:501' },
      { amount: 2, description: 'Affiliate share from food order' },
    ]);

    const all = await request(app).get('/referral/my-recruits?filter=all&range=28d');
    expect(all.status).toBe(200);
    expect(all.body.data.recruits).toHaveLength(2);
    expect(all.body.data.recruits[0]).toMatchObject({
      user: { username: 'cara' },
      lifetime_gmv: 50,
      earnings_attributed: 1.5,
      in_period: true,
    });
    expect(all.body.data.summary).toMatchObject({
      total: 2,
      in_period: 1,
      unattributed_earnings: 2,
    });

    const period = await request(app).get('/referral/my-recruits?filter=period&range=28d');
    expect(period.body.data.recruits).toHaveLength(1);
    expect(period.body.data.recruits[0].user.username).toBe('cara');
  });
});

describe('POST /referral/invite rate limit + pending guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue(false);
  });

  it('returns 429 when the daily invite cap is hit', async () => {
    checkRateLimit.mockResolvedValue(true);
    const res = await request(app).post('/referral/invite').send({ username: 'bob' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/limit/i);
  });

  it('rejects a second invite while one is still pending', async () => {
    prisma.user.findUnique.mockResolvedValue({ ref_code: 'STRUG-ME', name: 'Me', username: 'me' });
    prisma.user.findFirst.mockResolvedValue({ user_id: 200, username: 'bob', name: 'Bob' });
    prisma.shared_ref_code.findFirst.mockResolvedValue(null);
    prisma.recruit_invite.findUnique.mockResolvedValue({
      invite_id: 5,
      status: 'pending',
      created_at: new Date(),
      recruiter_user_id: 100,
      invited_user_id: 200,
    });

    const res = await request(app).post('/referral/invite').send({ username: 'bob' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already pending/i);
  });
});

describe('invite accept expiry + resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue(false);
  });

  it('rejects accept on an expired invite with 410', async () => {
    prisma.recruit_invite.findUnique.mockResolvedValue({
      invite_id: 7,
      invited_user_id: 100,
      recruiter_user_id: 50,
      status: 'pending',
      ref_code: 'STRUG-X',
      created_at: new Date('2020-01-01T00:00:00.000Z'),
    });
    const res = await request(app).post('/referral/invites/7/accept');
    expect(res.status).toBe(410);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('resent expired invite resets to pending and notifies', async () => {
    prisma.recruit_invite.findUnique.mockResolvedValue({
      invite_id: 8,
      recruiter_user_id: 100,
      invited_user_id: 200,
      status: 'pending',
      ref_code: 'STRUG-ME',
      created_at: new Date('2020-01-01T00:00:00.000Z'),
      invited: { user_id: 200, username: 'bob', name: 'Bob' },
    });
    prisma.shared_ref_code.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ ref_code: 'STRUG-ME', name: 'Me', username: 'me' });
    prisma.recruit_invite.update.mockResolvedValue({
      invite_id: 8,
      recruiter_user_id: 100,
      invited_user_id: 200,
      status: 'pending',
      ref_code: 'STRUG-ME',
      created_at: new Date(),
      responded_at: null,
      invited: { user_id: 200, username: 'bob', name: 'Bob' },
    });

    const res = await request(app).post('/referral/invites/8/resend');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/resent/i);
    expect(res.body.invite.status).toBe('pending');
    expect(res.body.invite.can_resend).toBe(false);
    expect(notify).toHaveBeenCalled();
  });

  it('blocks resend while invite is still fresh pending', async () => {
    prisma.recruit_invite.findUnique.mockResolvedValue({
      invite_id: 9,
      recruiter_user_id: 100,
      invited_user_id: 200,
      status: 'pending',
      ref_code: 'STRUG-ME',
      created_at: new Date(),
      invited: { user_id: 200, username: 'bob', name: 'Bob' },
    });
    const res = await request(app).post('/referral/invites/9/resend');
    expect(res.status).toBe(409);
  });
});

describe('GET /referral/invites hides expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters out expired pending invites for the invitee', async () => {
    prisma.recruit_invite.findMany.mockResolvedValue([
      {
        invite_id: 1,
        status: 'pending',
        ref_code: 'A',
        created_at: new Date(),
        responded_at: null,
        recruiter: { user_id: 1, username: 'a', name: 'A' },
      },
      {
        invite_id: 2,
        status: 'pending',
        ref_code: 'B',
        created_at: new Date('2020-01-01T00:00:00.000Z'),
        responded_at: null,
        recruiter: { user_id: 2, username: 'b', name: 'B' },
      },
    ]);
    const res = await request(app).get('/referral/invites');
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0].invite_id).toBe(1);
  });
});
