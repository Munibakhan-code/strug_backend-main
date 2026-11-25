import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import router from '../../routes/social-follow-routes.js';
import prisma from '../../utils/prisma-client.js';

const authState = vi.hoisted(() => ({ user: { user_id: 10, profile_id: 99 } }));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    follower: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    social_block: {
      findMany: vi.fn(),
    },
    social_profile: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = authState.user;
    next();
  },
  optionalAuth: (_req, _res, next) => next(),
}));

vi.mock('../../utils/social-follow.js', () => ({
  FOLLOW_ACCEPTED: 'accepted',
  FOLLOW_PENDING: 'pending',
  toggleFollowEdge: vi.fn(),
  acceptFollowRequest: vi.fn(),
  rejectFollowRequest: vi.fn(),
}));

const app = express();
app.use(express.json());
app.use('/social-follow', router);

describe('GET /social-follow/requests (#1626)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { user_id: 10, profile_id: 99 };
    prisma.social_block.findMany.mockResolvedValue([]);
  });

  it('returns 400 when profile_id missing', async () => {
    authState.user = { user_id: 1 };
    const res = await request(app).get('/social-follow/requests');
    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
  });

  it('lists pending inbound requests for the owner', async () => {
    prisma.follower.findMany.mockResolvedValue([
      {
        follower_id: 5,
        created_at: new Date('2026-08-01T12:00:00Z'),
        follower: {
          profile_id: 5,
          user_id: 50,
          handle: 'fan_one',
          display_name: 'Fan One',
          profile_pic_url: null,
          is_verified: false,
        },
      },
    ]);

    const res = await request(app).get('/social-follow/requests');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].requester_profile_id).toBe(5);
    expect(res.body.data[0].requester.handle).toBe('fan_one');
    expect(prisma.follower.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          following_id: 99,
          status: 'pending',
        }),
      }),
    );
  });

  it('excludes blocked profiles from the pending list', async () => {
    prisma.social_block.findMany.mockResolvedValue([
      { blocker_id: 99, blocked_id: 7 },
    ]);
    prisma.follower.findMany.mockResolvedValue([]);

    await request(app).get('/social-follow/requests');

    expect(prisma.follower.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          follower_id: { notIn: [7] },
        }),
      }),
    );
  });

  it('returns empty data when there are no pending rows', async () => {
    prisma.follower.findMany.mockResolvedValue([]);
    const res = await request(app).get('/social-follow/requests');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
