import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import router from '../../routes/social-privacy-routes.js';
import prisma from '../../utils/prisma-client.js';
import { outgoingBlockedGraphForUser } from '../../utils/platform-blocks.js';

const authState = vi.hoisted(() => ({ user: { user_id: 10, profile_id: 99 } }));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    close_friend: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
    },
    social_profile: {
      findUnique: vi.fn(),
    },
    social_block: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    social_mute: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = authState.user;
    next();
  },
}));

vi.mock('../../utils/platform-blocks.js', () => ({
  blockedSocialProfilesForUser: vi.fn(),
  closeDirectChatsBetweenUsers: vi.fn(),
  createPlatformBlockBetweenUsers: vi.fn(),
  deletePlatformBlockBetweenUsers: vi.fn(),
  ensureSocialProfileForUser: vi.fn(),
  outgoingBlockedGraphForUser: vi.fn(),
}));

vi.mock('../../utils/social-follow.js', () => ({
  acceptPendingInboundOnGoPublic: vi.fn(),
}));

const app = express();
app.use(express.json());
app.use('/social-privacy', router);

describe('GET /social-privacy/close-friends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { user_id: 10, profile_id: 99 };
    prisma.social_block.findMany.mockResolvedValue([]);
    outgoingBlockedGraphForUser.mockResolvedValue({ userIds: [], profileIds: [] });
  });

  it('returns 400 when profile_id is missing', async () => {
    authState.user = { user_id: 1 };
    const res = await request(app).get('/social-privacy/close-friends');
    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
  });

  it('lists close friends for the viewer', async () => {
    prisma.close_friend.findMany.mockResolvedValue([
      {
        friend: {
          profile_id: 5,
          user_id: 50,
          display_name: 'Sam',
          handle: 'sam',
          profile_pic_url: null,
        },
      },
      { friend: null },
    ]);

    const res = await request(app).get('/social-privacy/close-friends');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].display_name).toBe('Sam');
    expect(prisma.close_friend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profile_id: 99 },
        take: 100,
      }),
    );
  });

  it('returns empty data when viewer has no close friends', async () => {
    prisma.close_friend.findMany.mockResolvedValue([]);
    const res = await request(app).get('/social-privacy/close-friends');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('excludes blocked profiles from the close friends list', async () => {
    prisma.social_block.findMany.mockResolvedValue([
      { blocker_id: 99, blocked_id: 5 },
    ]);
    prisma.close_friend.findMany.mockResolvedValue([]);

    const res = await request(app).get('/social-privacy/close-friends');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(prisma.close_friend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profile_id: 99,
          friend_id: { notIn: expect.arrayContaining([5]) },
        }),
      }),
    );
  });

  it('excludes platform-blocked user ids even when close_friend row remains', async () => {
    outgoingBlockedGraphForUser.mockResolvedValue({ userIds: [50], profileIds: [] });
    prisma.close_friend.findMany.mockResolvedValue([
      {
        friend: {
          profile_id: 5,
          user_id: 50,
          display_name: 'Sam',
          handle: 'sam',
          profile_pic_url: null,
        },
      },
    ]);

    const res = await request(app).get('/social-privacy/close-friends');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /social-privacy/close-friends/:target_id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { user_id: 10, profile_id: 99 };
  });

  it('returns 400 for invalid target id', async () => {
    const res = await request(app).post('/social-privacy/close-friends/not-a-number');
    expect(res.status).toBe(400);
  });

  it('returns 400 when adding yourself', async () => {
    const res = await request(app).post('/social-privacy/close-friends/99');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cannot add yourself');
  });
});
