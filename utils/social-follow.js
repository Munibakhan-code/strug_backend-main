import prisma from './prisma-client.js';
import { createNotification } from './notification-service.js';
import { appPublicBase, emitSocialProfileMail } from './emit-user-mail.js';

export const FOLLOW_ACCEPTED = 'accepted';
export const FOLLOW_PENDING = 'pending';

export async function hasAcceptedFollow(followerId, followingId) {
  if (!followerId || !followingId) return false;
  const rel = await prisma.follower.findUnique({
    where: {
      follower_id_following_id: {
        follower_id: followerId,
        following_id: followingId,
      },
    },
    select: { status: true },
  });
  return rel?.status === FOLLOW_ACCEPTED;
}

/**
 * Follow / unfollow / cancel-request. Private targets get a pending row, not an accepted edge.
 */
export async function toggleFollowEdge({ myProfileId, targetProfile, io }) {
  const targetId = targetProfile.profile_id;
  const existing = await prisma.follower.findUnique({
    where: {
      follower_id_following_id: {
        follower_id: myProfileId,
        following_id: targetId,
      },
    },
  });

  if (existing) {
    await prisma.follower.delete({ where: { id: existing.id } });
    return { action: existing.status === FOLLOW_PENDING ? 'cancelled' : 'unfollowed' };
  }

  const status = targetProfile.is_private ? FOLLOW_PENDING : FOLLOW_ACCEPTED;
  await prisma.follower.create({
    data: {
      follower_id: myProfileId,
      following_id: targetId,
      status,
    },
  });

  if (status === FOLLOW_ACCEPTED && io) {
    await createNotification(io, {
      receiver_id: targetId,
      sender_id: myProfileId,
      type: 'FOLLOW',
      target_id: myProfileId,
    });
    const follower = await prisma.social_profile.findUnique({
      where: { profile_id: myProfileId },
      select: { display_name: true },
    });
    emitSocialProfileMail({
      profileId: targetId,
      templateName: 'social-new-follower',
      subjectKey: 'emails.social_new_follower.subject',
      variables: {
        follower_name: follower?.display_name || 'Someone',
        cta_url: `${appPublicBase()}/`,
      },
    }).catch(() => {});
  }

  return { action: status === FOLLOW_PENDING ? 'requested' : 'followed' };
}

export async function acceptFollowRequest({ ownerProfileId, requesterProfileId, io }) {
  const rel = await prisma.follower.findUnique({
    where: {
      follower_id_following_id: {
        follower_id: requesterProfileId,
        following_id: ownerProfileId,
      },
    },
  });
  if (!rel || rel.status !== FOLLOW_PENDING) {
    return { ok: false, status: 404, message: 'Request not found.' };
  }
  await prisma.follower.update({
    where: { id: rel.id },
    data: { status: FOLLOW_ACCEPTED },
  });
  if (io) {
    await createNotification(io, {
      receiver_id: requesterProfileId,
      sender_id: ownerProfileId,
      type: 'FOLLOW',
      target_id: ownerProfileId,
    });
    const requester = await prisma.social_profile.findUnique({
      where: { profile_id: requesterProfileId },
      select: { display_name: true },
    });
    // Owner gained a follower when they accepted the request.
    emitSocialProfileMail({
      profileId: ownerProfileId,
      templateName: 'social-new-follower',
      subjectKey: 'emails.social_new_follower.subject',
      variables: {
        follower_name: requester?.display_name || 'Someone',
        cta_url: `${appPublicBase()}/`,
      },
    }).catch(() => {});
  }
  return { ok: true };
}

export async function rejectFollowRequest({ ownerProfileId, requesterProfileId }) {
  const deleted = await prisma.follower.deleteMany({
    where: {
      follower_id: requesterProfileId,
      following_id: ownerProfileId,
      status: FOLLOW_PENDING,
    },
  });
  if (!deleted.count) {
    return { ok: false, status: 404, message: 'Request not found.' };
  }
  return { ok: true };
}

/**
 * #1223: when a private profile goes public, pending inbound requests would otherwise
 * sit on "Requested" forever. Auto-accept them (no per-requester notify fan-out).
 * @param {number} ownerProfileId
 * @param {{ follower?: { updateMany: Function } }} [db] — defaults to prisma; pass tx in a transaction
 */
export async function acceptPendingInboundOnGoPublic(ownerProfileId, db = prisma) {
  if (!ownerProfileId) return { accepted: 0 };
  const result = await db.follower.updateMany({
    where: {
      following_id: ownerProfileId,
      status: FOLLOW_PENDING,
    },
    data: { status: FOLLOW_ACCEPTED },
  });
  return { accepted: result.count };
}

