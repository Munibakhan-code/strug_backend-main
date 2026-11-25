import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, createNotification, emitSocialProfileMail } = vi.hoisted(() => ({
  prismaMock: {
    follower: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    social_profile: {
      findUnique: vi.fn(),
    },
  },
  createNotification: vi.fn(),
  emitSocialProfileMail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/notification-service.js', () => ({ createNotification }));
vi.mock('../../utils/emit-user-mail.js', () => ({
  appPublicBase: () => 'https://app.strug.ca',
  emitSocialProfileMail,
}));

const {
  toggleFollowEdge,
  acceptFollowRequest,
  rejectFollowRequest,
  hasAcceptedFollow,
  acceptPendingInboundOnGoPublic,
} = await import('../../utils/social-follow.js');

describe('toggleFollowEdge (#1189)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitSocialProfileMail.mockResolvedValue({ ok: true });
  });

  it('creates an accepted follow on a public profile', async () => {
    prismaMock.follower.findUnique.mockResolvedValue(null);
    prismaMock.follower.create.mockResolvedValue({ id: 1, status: 'accepted' });
    prismaMock.social_profile.findUnique.mockResolvedValue({ display_name: 'Ada' });

    const out = await toggleFollowEdge({
      myProfileId: 1,
      targetProfile: { profile_id: 2, is_private: false },
      io: {},
    });

    expect(out.action).toBe('followed');
    expect(prismaMock.follower.create).toHaveBeenCalledWith({
      data: { follower_id: 1, following_id: 2, status: 'accepted' },
    });
    expect(createNotification).toHaveBeenCalled();
    expect(prismaMock.social_profile.findUnique).toHaveBeenCalledWith({
      where: { profile_id: 1 },
      select: { display_name: true },
    });
    expect(emitSocialProfileMail).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 2,
        templateName: 'social-new-follower',
        variables: expect.objectContaining({ follower_name: 'Ada' }),
      }),
    );
  });

  it('falls back to Someone when follower display_name is missing', async () => {
    prismaMock.follower.findUnique.mockResolvedValue(null);
    prismaMock.follower.create.mockResolvedValue({ id: 1, status: 'accepted' });
    prismaMock.social_profile.findUnique.mockResolvedValue(null);

    await toggleFollowEdge({
      myProfileId: 1,
      targetProfile: { profile_id: 2, is_private: false },
      io: {},
    });

    expect(emitSocialProfileMail).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({ follower_name: 'Someone' }),
      }),
    );
  });

  it('creates a pending request on a private profile and does not notify FOLLOW yet', async () => {
    prismaMock.follower.findUnique.mockResolvedValue(null);
    prismaMock.follower.create.mockResolvedValue({ id: 2, status: 'pending' });

    const out = await toggleFollowEdge({
      myProfileId: 1,
      targetProfile: { profile_id: 2, is_private: true },
      io: {},
    });

    expect(out.action).toBe('requested');
    expect(prismaMock.follower.create).toHaveBeenCalledWith({
      data: { follower_id: 1, following_id: 2, status: 'pending' },
    });
    expect(createNotification).not.toHaveBeenCalled();
    expect(prismaMock.social_profile.findUnique).not.toHaveBeenCalled();
    expect(emitSocialProfileMail).not.toHaveBeenCalled();
  });

  it('cancels a pending request on second toggle', async () => {
    prismaMock.follower.findUnique.mockResolvedValue({ id: 9, status: 'pending' });
    prismaMock.follower.delete.mockResolvedValue({});

    const out = await toggleFollowEdge({
      myProfileId: 1,
      targetProfile: { profile_id: 2, is_private: true },
    });

    expect(out.action).toBe('cancelled');
    expect(prismaMock.follower.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });

  it('unfollows an accepted edge', async () => {
    prismaMock.follower.findUnique.mockResolvedValue({ id: 9, status: 'accepted' });
    prismaMock.follower.delete.mockResolvedValue({});

    const out = await toggleFollowEdge({
      myProfileId: 1,
      targetProfile: { profile_id: 2, is_private: false },
    });

    expect(out.action).toBe('unfollowed');
  });
});

describe('follow request accept/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitSocialProfileMail.mockResolvedValue({ ok: true });
  });

  it('accepts a pending request', async () => {
    prismaMock.follower.findUnique.mockResolvedValue({ id: 3, status: 'pending' });
    prismaMock.follower.update.mockResolvedValue({});
    prismaMock.social_profile.findUnique.mockResolvedValue({ display_name: 'Bob' });
    const out = await acceptFollowRequest({ ownerProfileId: 2, requesterProfileId: 1, io: {} });
    expect(out.ok).toBe(true);
    expect(prismaMock.follower.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { status: 'accepted' },
    });
    expect(prismaMock.social_profile.findUnique).toHaveBeenCalledWith({
      where: { profile_id: 1 },
      select: { display_name: true },
    });
    expect(emitSocialProfileMail).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 2,
        templateName: 'social-new-follower',
        variables: expect.objectContaining({ follower_name: 'Bob' }),
      }),
    );
  });

  it('404s accept when there is no pending row', async () => {
    prismaMock.follower.findUnique.mockResolvedValue({ id: 3, status: 'accepted' });
    const out = await acceptFollowRequest({ ownerProfileId: 2, requesterProfileId: 1 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
  });

  it('rejects missing pending with 404', async () => {
    prismaMock.follower.deleteMany.mockResolvedValue({ count: 0 });
    const out = await rejectFollowRequest({ ownerProfileId: 2, requesterProfileId: 1 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
  });

  it('hasAcceptedFollow is false for pending and empty', async () => {
    prismaMock.follower.findUnique.mockResolvedValue({ status: 'pending' });
    expect(await hasAcceptedFollow(1, 2)).toBe(false);
    prismaMock.follower.findUnique.mockResolvedValue(null);
    expect(await hasAcceptedFollow(1, 2)).toBe(false);
    expect(await hasAcceptedFollow(null, 2)).toBe(false);
  });
});

describe('acceptPendingInboundOnGoPublic (#1223)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('auto-accepts pending inbound requests for the owner', async () => {
    prismaMock.follower.updateMany.mockResolvedValue({ count: 3 });
    const out = await acceptPendingInboundOnGoPublic(42);
    expect(out).toEqual({ accepted: 3 });
    expect(prismaMock.follower.updateMany).toHaveBeenCalledWith({
      where: { following_id: 42, status: 'pending' },
      data: { status: 'accepted' },
    });
  });

  it('returns zero when there are no pending rows', async () => {
    prismaMock.follower.updateMany.mockResolvedValue({ count: 0 });
    expect(await acceptPendingInboundOnGoPublic(7)).toEqual({ accepted: 0 });
  });

  it('does not query when ownerProfileId is missing', async () => {
    expect(await acceptPendingInboundOnGoPublic(null)).toEqual({ accepted: 0 });
    expect(await acceptPendingInboundOnGoPublic(undefined)).toEqual({ accepted: 0 });
    expect(prismaMock.follower.updateMany).not.toHaveBeenCalled();
  });

  it('uses an injected db client when provided (transaction path)', async () => {
    const tx = { follower: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const out = await acceptPendingInboundOnGoPublic(9, tx);
    expect(out).toEqual({ accepted: 1 });
    expect(tx.follower.updateMany).toHaveBeenCalled();
    expect(prismaMock.follower.updateMany).not.toHaveBeenCalled();
  });
});
