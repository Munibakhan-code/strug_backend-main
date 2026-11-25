import prisma from './prisma-client.js';
import { FOLLOW_ACCEPTED } from './social-follow.js';

/** Count social-graph followers for a user (live Follow button uses this graph). */
export async function countSocialFollowersForUserId(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid)) return 0;
  const sp = await prisma.social_profile.findUnique({
    where: { user_id: uid },
    // A pending request to a private profile is not a follower, and counting it here
    // tells the requester their request landed. Live routes read this for public display.
    select: { _count: { select: { followers: { where: { status: FOLLOW_ACCEPTED } } } } },
  });
  return sp?._count?.followers ?? 0;
}
