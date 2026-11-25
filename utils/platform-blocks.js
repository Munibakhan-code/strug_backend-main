import prisma from './prisma-client.js';

export function platformBlockError(message = 'This interaction is not available.') {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

export async function socialProfilesForUsers(userIds, db = prisma) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  if (!db?.social_profile?.findMany) return new Map();
  const rows = await db.social_profile.findMany({
    where: { user_id: { in: ids } },
    select: {
      profile_id: true,
      user_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      created_at: true,
    },
  });
  return new Map(rows.map((row) => [row.user_id, row]));
}

function fallbackHandleForUser(userId) {
  return `user-${Number(userId)}`;
}

export async function ensureSocialProfileForUser(userId, db = prisma) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const existing = db?.social_profile?.findUnique ? await db.social_profile.findUnique({
    where: { user_id: id },
    select: {
      profile_id: true,
      user_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      created_at: true,
    },
  }) : null;
  if (existing) return existing;
  if (!db?.social_profile?.create) {
    const profiles = await socialProfilesForUsers([id], db);
    return profiles.get(id) || {
      profile_id: id,
      user_id: id,
      display_name: `User ${id}`,
      handle: fallbackHandleForUser(id),
      profile_pic_url: null,
      created_at: null,
    };
  }
  if (!db?.user?.findUnique || !db?.social_profile?.create) return null;
  const user = await db.user.findUnique({
    where: { user_id: id },
    select: { user_id: true, name: true, username: true, email: true },
  });
  if (!user) return null;
  const baseHandle = String(user.username || user.email?.split('@')?.[0] || fallbackHandleForUser(id))
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 40) || fallbackHandleForUser(id);
  const handle = `${baseHandle}-${id}`.slice(0, 50);
  return db.social_profile.create({
    data: {
      user_id: id,
      handle,
      display_name: String(user.name || user.username || `User ${id}`).slice(0, 100),
    },
    select: {
      profile_id: true,
      user_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      created_at: true,
    },
  });
}

export async function blockedGraphForUser(userId, db = prisma) {
  const user = Number(userId);
  if (!Number.isInteger(user) || user <= 0) return { userIds: [], profileIds: [] };
  const me = db?.social_profile?.findUnique ? await db.social_profile.findUnique({
    where: { user_id: user },
    select: { profile_id: true },
  }).catch(() => null) : null;
  const datingBlocks = db?.dating_swipe?.findMany ? await db.dating_swipe.findMany({
    where: {
      action: 'block',
      OR: [{ actor_id: user }, { target_id: user }],
    },
    select: { actor_id: true, target_id: true },
  }).catch(() => []) : [];
  const userIds = new Set(
    datingBlocks
      .map((row) => (Number(row.actor_id) === user ? row.target_id : row.actor_id))
      .filter((id) => Number.isInteger(Number(id)) && Number(id) > 0)
      .map(Number)
  );
  const profileIds = new Set();
  if (me?.profile_id) {
    const socialBlocks = db?.social_block?.findMany ? await db.social_block.findMany({
      where: {
        OR: [
          { blocker_id: me.profile_id },
          { blocked_id: me.profile_id },
        ],
      },
      select: { blocker_id: true, blocked_id: true },
    }).catch(() => []) : [];
    const otherProfileIds = socialBlocks
      .map((row) => (Number(row.blocker_id) === Number(me.profile_id) ? row.blocked_id : row.blocker_id))
      .filter((id) => Number.isInteger(Number(id)) && Number(id) > 0)
      .map(Number);
    otherProfileIds.forEach((id) => profileIds.add(id));
    if (otherProfileIds.length) {
      const profiles = await db.social_profile.findMany({
        where: { profile_id: { in: otherProfileIds } },
        select: { user_id: true },
      }).catch(() => []);
      profiles.forEach((profile) => {
        if (profile.user_id) userIds.add(Number(profile.user_id));
      });
    }
  }
  if (userIds.size) {
    const profiles = db?.social_profile?.findMany ? await db.social_profile.findMany({
      where: { user_id: { in: Array.from(userIds) } },
      select: { profile_id: true },
    }).catch(() => []) : [];
    profiles.forEach((profile) => {
      if (profile.profile_id) profileIds.add(Number(profile.profile_id));
    });
  }
  return { userIds: Array.from(userIds), profileIds: Array.from(profileIds) };
}

export async function outgoingBlockedGraphForUser(userId, db = prisma) {
  const user = Number(userId);
  if (!Number.isInteger(user) || user <= 0) return { userIds: [], profileIds: [] };
  const userIds = new Set();
  const profileIds = new Set();
  const datingRows = db?.dating_swipe?.findMany ? await db.dating_swipe.findMany({
    where: { actor_id: user, action: 'block' },
    select: { target_id: true },
  }).catch(() => []) : [];
  datingRows.forEach((row) => {
    if (row.target_id) userIds.add(Number(row.target_id));
  });
  const me = db?.social_profile?.findUnique ? await db.social_profile.findUnique({
    where: { user_id: user },
    select: { profile_id: true },
  }).catch(() => null) : null;
  if (me?.profile_id) {
    const socialRows = db?.social_block?.findMany ? await db.social_block.findMany({
      where: { blocker_id: me.profile_id },
      select: { blocked_id: true },
    }).catch(() => []) : [];
    socialRows.forEach((row) => {
      if (row.blocked_id) profileIds.add(Number(row.blocked_id));
    });
  }
  if (userIds.size) {
    const profiles = db?.social_profile?.findMany ? await db.social_profile.findMany({
      where: { user_id: { in: Array.from(userIds) } },
      select: { profile_id: true },
    }).catch(() => []) : [];
    profiles.forEach((profile) => {
      if (profile.profile_id) profileIds.add(Number(profile.profile_id));
    });
  }
  if (profileIds.size) {
    const profiles = db?.social_profile?.findMany ? await db.social_profile.findMany({
      where: { profile_id: { in: Array.from(profileIds) } },
      select: { user_id: true },
    }).catch(() => []) : [];
    profiles.forEach((profile) => {
      if (profile.user_id) userIds.add(Number(profile.user_id));
    });
  }
  return { userIds: Array.from(userIds), profileIds: Array.from(profileIds) };
}

export async function areUsersBlockedOnPlatform(userAId, userBId, db = prisma) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return false;
  const datingBlock = db?.dating_swipe?.findFirst ? await db.dating_swipe.findFirst({
    where: {
      action: 'block',
      OR: [
        { actor_id: a, target_id: b },
        { actor_id: b, target_id: a },
      ],
    },
    select: { dating_swipe_id: true },
  }).catch(() => null) : null;
  if (datingBlock) return true;
  const profiles = await socialProfilesForUsers([a, b], db);
  const profileA = profiles.get(a);
  const profileB = profiles.get(b);
  if (!profileA?.profile_id || !profileB?.profile_id) return false;
  const block = await db.social_block.findFirst({
    where: {
      OR: [
        { blocker_id: profileA.profile_id, blocked_id: profileB.profile_id },
        { blocker_id: profileB.profile_id, blocked_id: profileA.profile_id },
      ],
    },
    select: { block_id: true },
  });
  return Boolean(block);
}

export async function areSocialProfilesBlocked(profileAId, profileBId, db = prisma) {
  const a = Number(profileAId);
  const b = Number(profileBId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return false;
  const block = await db.social_block.findFirst({
    where: {
      OR: [
        { blocker_id: a, blocked_id: b },
        { blocker_id: b, blocked_id: a },
      ],
    },
    select: { block_id: true },
  });
  return Boolean(block);
}

export async function assertNoSocialProfileBlock(profileAId, profileBId, db = prisma) {
  if (await areSocialProfilesBlocked(profileAId, profileBId, db)) {
    throw platformBlockError();
  }
}

export async function blockedSocialProfilesForUser(userId, db = prisma) {
  const user = Number(userId);
  if (!Number.isInteger(user) || user <= 0) return [];
  const me = await db.social_profile.findUnique({
    where: { user_id: user },
    select: { profile_id: true },
  }).catch(() => null);
  const graph = await outgoingBlockedGraphForUser(user, db);
  const rows = await db.social_block.findMany({
    where: me?.profile_id ? { blocker_id: me.profile_id } : { block_id: -1 },
    orderBy: { created_at: 'desc' },
    include: {
      blocked: {
        select: {
          profile_id: true,
          user_id: true,
          display_name: true,
          handle: true,
          profile_pic_url: true,
        },
      },
    },
  });
  const rowProfileIds = new Set(rows.map((row) => row.blocked?.profile_id).filter(Boolean));
  const datingOnlyProfileIds = graph.profileIds.filter((profileId) => !rowProfileIds.has(profileId));
  if (!datingOnlyProfileIds.length) return rows;
  const datingOnlyProfiles = await db.social_profile.findMany({
    where: { profile_id: { in: datingOnlyProfileIds } },
    select: {
      profile_id: true,
      user_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      created_at: true,
    },
  }).catch(() => []);
  return [
    ...rows,
    ...datingOnlyProfiles.map((blocked) => ({
      block_id: null,
      created_at: blocked.created_at,
      blocked,
    })),
  ];
}

export async function createPlatformBlockBetweenUsers(db, blockerUserId, blockedUserId) {
  const blockerId = Number(blockerUserId);
  const blockedId = Number(blockedUserId);
  if (!Number.isInteger(blockerId) || !Number.isInteger(blockedId) || blockerId <= 0 || blockedId <= 0 || blockerId === blockedId) {
    return null;
  }
  const blocker = await ensureSocialProfileForUser(blockerId, db);
  const blocked = await ensureSocialProfileForUser(blockedId, db);
  if (!blocker?.profile_id || !blocked?.profile_id) {
    throw platformBlockError('Unable to create a platform block for this account.');
  }
  const block = await db.social_block.upsert({
    where: { blocker_id_blocked_id: { blocker_id: blocker.profile_id, blocked_id: blocked.profile_id } },
    update: {},
    create: { blocker_id: blocker.profile_id, blocked_id: blocked.profile_id },
  });
  await db.follower.deleteMany({
    where: {
      OR: [
        { follower_id: blocker.profile_id, following_id: blocked.profile_id },
        { follower_id: blocked.profile_id, following_id: blocker.profile_id },
      ],
    },
  });
  return block;
}

export async function deletePlatformBlockBetweenUsers(db, blockerUserId, blockedUserId) {
  const blockerId = Number(blockerUserId);
  const blockedId = Number(blockedUserId);
  if (!Number.isInteger(blockerId) || !Number.isInteger(blockedId) || blockerId <= 0 || blockedId <= 0 || blockerId === blockedId) {
    return { dating: 0, social: 0, restored_chats: 0, restored_dating_matches: 0 };
  }
  const profiles = await socialProfilesForUsers([blockerId, blockedId], db);
  const blocker = profiles.get(blockerId);
  const blocked = profiles.get(blockedId);
  const datingResult = await db.dating_swipe.deleteMany({
    where: { actor_id: blockerId, target_id: blockedId, action: 'block' },
  }).catch(() => ({ count: 0 }));
  const socialResult = blocker?.profile_id && blocked?.profile_id
    ? await db.social_block.deleteMany({
        where: { blocker_id: blocker.profile_id, blocked_id: blocked.profile_id },
      }).catch(() => ({ count: 0 }))
    : { count: 0 };
  const stillBlocked = await areUsersBlockedOnPlatform(blockerId, blockedId, db);
  let restoredChats = 0;
  let restoredDatingMatches = 0;
  if (!stillBlocked) {
    restoredChats = await restoreDirectChatsBetweenUsers(db, blockerId, blockedId);
    restoredDatingMatches = await restoreDatingMatchesBetweenUsers(db, blockerId, blockedId);
  }
  return {
    dating: datingResult.count || 0,
    social: socialResult.count || 0,
    restored_chats: restoredChats,
    restored_dating_matches: restoredDatingMatches,
  };
}

export async function closeDirectChatsBetweenUsers(db, userAId, userBId) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return 0;
  const dmKey = `dm_${Math.min(a, b)}_${Math.max(a, b)}`;
  const channels = await db.chat_channel.findMany({
    where: {
      OR: [
        { dm_key: dmKey },
        {
          type: 'dm',
          AND: [
            { chat_participants: { some: { user_id: a } } },
            { chat_participants: { some: { user_id: b } } },
          ],
        },
      ],
    },
    select: { channel_id: true },
  });
  const channelIds = channels.map((channel) => channel.channel_id).filter(Boolean);
  if (!channelIds.length) return 0;
  await db.chat_channel.updateMany({
    where: { channel_id: { in: channelIds } },
    data: { status: 'blocked' },
  });
  await db.chat_participants.updateMany({
    where: { channel_id: { in: channelIds }, user_id: { in: [a, b] } },
    data: { left_at: new Date() },
  });
  return channelIds.length;
}

export async function restoreDirectChatsBetweenUsers(db, userAId, userBId) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return 0;
  const dmKey = `dm_${Math.min(a, b)}_${Math.max(a, b)}`;
  const channels = await db.chat_channel.findMany({
    where: {
      OR: [
        { dm_key: dmKey },
        {
          type: 'dm',
          AND: [
            { chat_participants: { some: { user_id: a } } },
            { chat_participants: { some: { user_id: b } } },
          ],
        },
      ],
    },
    select: { channel_id: true },
  }).catch(() => []);
  const channelIds = channels.map((channel) => channel.channel_id).filter(Boolean);
  if (!channelIds.length) return 0;
  await db.chat_channel.updateMany({
    where: { channel_id: { in: channelIds }, status: 'blocked' },
    data: { status: 'active' },
  }).catch(() => ({ count: 0 }));
  await db.chat_participants.updateMany({
    where: { channel_id: { in: channelIds }, user_id: { in: [a, b] } },
    data: { left_at: null },
  }).catch(() => ({ count: 0 }));
  return channelIds.length;
}

export async function restoreDatingMatchesBetweenUsers(db, userAId, userBId) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return 0;
  const userA = Math.min(a, b);
  const userB = Math.max(a, b);
  const result = await db.dating_match.updateMany({
    where: { user_a_id: userA, user_b_id: userB, status: 'blocked' },
    data: { status: 'matched', unmatched_at: null },
  }).catch(() => ({ count: 0 }));
  return result.count || 0;
}

export async function assertNoPlatformBlockBetweenUsers(userAId, userBId, db = prisma) {
  if (await areUsersBlockedOnPlatform(userAId, userBId, db)) {
    throw platformBlockError();
  }
}
