import prisma from './prisma-client.js';

/**
 * Resolve profile_ids the viewer should not see content from:
 * - either-direction blocks
 * - mutes where mute_posts is true
 */
export async function getHiddenProfileIds(viewerProfileId) {
  if (!viewerProfileId) return [];

  const [blocks, mutes] = await Promise.all([
    prisma.social_block.findMany({
      where: {
        OR: [
          { blocker_id: viewerProfileId },
          { blocked_id: viewerProfileId },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    }),
    prisma.social_mute.findMany({
      where: { muter_id: viewerProfileId, mute_posts: true },
      select: { muted_id: true },
    }),
  ]);

  const hidden = new Set();
  for (const b of blocks) {
    if (b.blocker_id !== viewerProfileId) hidden.add(b.blocker_id);
    if (b.blocked_id !== viewerProfileId) hidden.add(b.blocked_id);
  }
  for (const m of mutes) hidden.add(m.muted_id);
  hidden.delete(viewerProfileId);
  return [...hidden];
}

/** Map hidden profile_ids → user_ids (Town Hall author key). */
export async function getHiddenUserIds(viewerProfileId) {
  const hiddenProfileIds = await getHiddenProfileIds(viewerProfileId);
  if (hiddenProfileIds.length === 0) return [];

  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: hiddenProfileIds } },
    select: { user_id: true },
  });
  return profiles.map((p) => p.user_id).filter(Boolean);
}

/**
 * Profile_ids whose posts should be excluded from Instagram-style feeds:
 * blocks/mutes + private profiles the viewer does not follow.
 */
export async function getExcludedAuthorProfileIds(viewerProfileId) {
  const hidden = await getHiddenProfileIds(viewerProfileId);

  const privateProfiles = await prisma.social_profile.findMany({
    where: {
      is_private: true,
      ...(viewerProfileId ? { profile_id: { not: viewerProfileId } } : {}),
    },
    select: { profile_id: true },
  });

  let followingIds = new Set();
  if (viewerProfileId) {
    const following = await prisma.follower.findMany({
      where: { follower_id: viewerProfileId, status: 'accepted' },
      select: { following_id: true },
    });
    followingIds = new Set(following.map((f) => f.following_id));
  }

  const privateNotFollowed = privateProfiles
    .map((p) => p.profile_id)
    .filter((id) => !followingIds.has(id));

  return [...new Set([...hidden, ...privateNotFollowed])];
}

/**
 * user_ids whose Town Hall posts should be excluded for this viewer:
 * blocks/mutes + private-profile authors the viewer does not follow.
 */
export async function getExcludedTownHallAuthorUserIds(viewerProfileId) {
  const excludedProfileIds = await getExcludedAuthorProfileIds(viewerProfileId);
  if (excludedProfileIds.length === 0) return [];

  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: excludedProfileIds } },
    select: { user_id: true },
  });
  return profiles.map((p) => p.user_id).filter(Boolean);
}

/** Prisma `notIn` helper — omit the clause when the list is empty. */
export function notInIds(field, ids) {
  if (!ids || ids.length === 0) return {};
  return { [field]: { notIn: ids } };
}

/**
 * Whether viewerProfileId may see posts belonging to authorProfileId.
 * Owner always can; private authors require a follow edge; blocks hide either way.
 */
export async function canViewerSeeAuthorPosts(viewerProfileId, authorProfileId) {
  if (!authorProfileId) return false;
  if (viewerProfileId && viewerProfileId === authorProfileId) return true;

  const author = await prisma.social_profile.findUnique({
    where: { profile_id: authorProfileId },
    select: { profile_id: true, is_private: true, is_banned: true, is_shadow_banned: true },
  });
  if (!author || author.is_banned) return false;

  if (viewerProfileId) {
    const block = await prisma.social_block.findFirst({
      where: {
        OR: [
          { blocker_id: viewerProfileId, blocked_id: authorProfileId },
          { blocker_id: authorProfileId, blocked_id: viewerProfileId },
        ],
      },
      select: { block_id: true },
    });
    if (block) return false;
  }

  if (!author.is_private) return true;
  if (!viewerProfileId) return false;

  const follow = await prisma.follower.findUnique({
    where: {
      follower_id_following_id: {
        follower_id: viewerProfileId,
        following_id: authorProfileId,
      },
    },
    select: { status: true },
  });
  return follow?.status === 'accepted';
}
