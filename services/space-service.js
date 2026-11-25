// #334 Community Spaces service — live group-audio room lifecycle + participant roles.
// Audio itself is peer-to-peer (WebRTC); this layer only owns who is in a room and in
// what role. See sockets/space-socket.js for the signaling relay.

import prisma from '../utils/prisma-client.js';

const ROLES = new Set(['host', 'speaker', 'listener']);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toPositiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw fail(`${field} must be a positive integer`);
  return n;
}

const participantUserSelect = {
  user_id: true,
  name: true,
  username: true,
  // social_profiles is a to-one relation (social_profile?) — Prisma rejects `take` on it
  // with a 500. identityFor() tolerates both object and array shapes, so no `take` needed.
  social_profiles: {
    select: { handle: true, display_name: true, profile_pic_url: true },
  },
};

function identityFor(user) {
  const sp = Array.isArray(user?.social_profiles) ? user.social_profiles[0] : user?.social_profiles;
  return {
    user_id: user?.user_id,
    name: sp?.display_name || user?.username || user?.name || 'User',
    handle: sp?.handle || user?.username || null,
    profile_pic_url: sp?.profile_pic_url || null,
  };
}

function shapeParticipant(p) {
  return {
    user_id: p.user_id,
    role: p.role,
    hand_raised: p.hand_raised,
    joined_at: p.joined_at,
    ...identityFor(p.user),
  };
}

// The schema names community_space's relations `user` (the host, via host_id) and
// `community_space_participant` — NOT `host`/`participants`. Querying the latter made
// Prisma throw a validation error on every space read/write, so the whole feature 500'd
// (#419). Query with the real names and normalise here so the shapers below keep reading
// the friendlier `host`/`participants`.
const spaceRelations = {
  user: { select: participantUserSelect },
  community_space_participant: {
    where: { left_at: null },
    include: { user: { select: participantUserSelect } },
    orderBy: { joined_at: 'asc' },
  },
};

function withFriendlyRelations(space) {
  return {
    ...space,
    host: space.user,
    participants: space.community_space_participant || [],
  };
}

// Access control for community-scoped spaces: a private/restricted community's spaces
// are members-only. Public communities and platform-wide spaces (no community) are open.
// Returns the resolved community_id (or null) so callers can persist it.
async function assertCommunityAccess(communityId, userId) {
  if (communityId == null || communityId === '') return null;
  const community = await prisma.community.findUnique({
    where: { community_id: String(communityId) },
    select: { community_id: true, type: true },
  });
  if (!community) throw fail('community not found', 404);
  if (community.type === 'private' || community.type === 'restricted') {
    const membership = await prisma.community_member.findUnique({
      where: { community_id_user_id: { community_id: community.community_id, user_id: userId } },
      select: { id: true },
    });
    if (!membership) throw fail('You must be a member of this community to use its spaces', 403);
  }
  return community.community_id;
}

// Only current participants may read a space's roster/details (prevents anyone from
// enumerating who is in a space they haven't joined).
export async function assertSpaceParticipant(spaceId, userId) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const participant = await prisma.community_space_participant.findFirst({
    where: { space_id: safeSpaceId, user_id: safeUserId, left_at: null },
    select: { id: true, role: true },
  });
  if (!participant) throw fail('You are not in this space', 403);
  return participant;
}

async function loadSpace(spaceId) {
  const space = await prisma.community_space.findUnique({
    where: { id: spaceId },
    include: spaceRelations,
  });
  if (!space) throw fail('Space not found', 404);
  return withFriendlyRelations(space);
}

function shapeSpace(space) {
  const active = (space.participants || []).filter((p) => !p.left_at);
  return {
    id: space.id,
    community_id: space.community_id,
    title: space.title,
    status: space.status,
    started_at: space.started_at,
    ended_at: space.ended_at,
    host: identityFor(space.host),
    host_id: space.host_id,
    participant_count: active.length,
    speaker_count: active.filter((p) => p.role === 'host' || p.role === 'speaker').length,
    participants: active.map(shapeParticipant),
  };
}

export async function createSpace({ hostId, communityId, title }) {
  const safeHostId = toPositiveInt(hostId, 'host_id');
  const safeTitle = String(title || '').trim();
  if (!safeTitle) throw fail('title is required');
  if (safeTitle.length > 200) throw fail('title must be 200 characters or fewer');

  // Creating a space in a private/restricted community requires membership.
  const safeCommunityId = await assertCommunityAccess(communityId, safeHostId);

  const created = await prisma.community_space.create({
    data: {
      host_id: safeHostId,
      community_id: safeCommunityId,
      title: safeTitle,
      status: 'live',
      community_space_participant: {
        create: { user_id: safeHostId, role: 'host' },
      },
    },
    select: { id: true },
  });
  return shapeSpace(await loadSpace(created.id));
}

export async function listLiveSpaces({ communityId } = {}) {
  const where = { status: 'live' };
  if (communityId != null && communityId !== '') where.community_id = String(communityId);
  const spaces = await prisma.community_space.findMany({
    where,
    include: {
      user: { select: participantUserSelect },
      // Count only — the browse list must not leak every participant's identity across
      // all live spaces to users who haven't joined.
      _count: { select: { community_space_participant: { where: { left_at: null } } } },
    },
    orderBy: { started_at: 'desc' },
    take: 100,
  });
  return spaces.map((space) => ({
    id: space.id,
    community_id: space.community_id,
    title: space.title,
    status: space.status,
    started_at: space.started_at,
    host: identityFor(space.user),
    host_id: space.host_id,
    participant_count: space._count?.community_space_participant ?? 0,
  }));
}

// #6: "previous spaces of people you follow" — ended (permanent) spaces hosted by the
// users the viewer follows, newest first. Audio replay itself needs a recording pipeline
// (spaces aren't captured yet) — `recording_url` is surfaced as null until that lands, so
// the client can show the past space and a "recording coming soon" state.
export async function listPastSpaces({ userId, communityId } = {}) {
  const viewer = await prisma.social_profile.findFirst({
    where: { user_id: toPositiveInt(userId, 'user_id') },
    select: { profile_id: true },
  });
  if (!viewer) return [];
  const follows = await prisma.follower.findMany({
    where: { follower_id: viewer.profile_id },
    select: { following_id: true },
  });
  if (follows.length === 0) return [];
  const followedProfiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: follows.map((f) => f.following_id) } },
    select: { user_id: true },
  });
  const followedUserIds = followedProfiles.map((p) => p.user_id).filter((id) => id != null);
  if (followedUserIds.length === 0) return [];

  const where = { status: 'ended', host_id: { in: followedUserIds } };
  if (communityId != null && communityId !== '') where.community_id = String(communityId);
  const spaces = await prisma.community_space.findMany({
    where,
    include: {
      user: { select: participantUserSelect },
      _count: { select: { community_space_participant: true } },
    },
    orderBy: { ended_at: 'desc' },
    take: 100,
  });
  return spaces.map((space) => ({
    id: space.id,
    community_id: space.community_id,
    title: space.title,
    status: space.status,
    started_at: space.started_at,
    ended_at: space.ended_at,
    host: identityFor(space.user),
    host_id: space.host_id,
    participant_count: space._count?.community_space_participant ?? 0,
    recording_url: null, // audio VOD not yet captured — see note above
  }));
}

export async function getSpace(spaceId) {
  return shapeSpace(await loadSpace(toPositiveInt(spaceId, 'space_id')));
}

export async function joinSpace({ spaceId, userId }) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const space = await prisma.community_space.findUnique({
    where: { id: safeSpaceId },
    select: { id: true, status: true, host_id: true, community_id: true },
  });
  if (!space) throw fail('Space not found', 404);
  if (space.status !== 'live') throw fail('This space has ended', 409);

  // Joining a space in a private/restricted community requires membership.
  await assertCommunityAccess(space.community_id, safeUserId);

  // Host always rejoins as host; everyone else joins/re-joins as listener.
  const role = space.host_id === safeUserId ? 'host' : 'listener';
  await prisma.community_space_participant.upsert({
    where: { space_id_user_id: { space_id: safeSpaceId, user_id: safeUserId } },
    update: { left_at: null, ...(role === 'host' ? { role: 'host' } : {}) },
    create: { space_id: safeSpaceId, user_id: safeUserId, role },
  });
  return shapeSpace(await loadSpace(safeSpaceId));
}

export async function leaveSpace({ spaceId, userId }) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const space = await prisma.community_space.findUnique({
    where: { id: safeSpaceId },
    select: { id: true, host_id: true, status: true },
  });
  if (!space) throw fail('Space not found', 404);

  await prisma.community_space_participant.updateMany({
    where: { space_id: safeSpaceId, user_id: safeUserId },
    data: { left_at: new Date() },
  });

  // When the host leaves, the space ends (no automatic host transfer in the scaffold).
  let ended = false;
  if (space.host_id === safeUserId && space.status === 'live') {
    await prisma.community_space.update({
      where: { id: safeSpaceId },
      data: { status: 'ended', ended_at: new Date() },
    });
    ended = true;
  }
  return { space_id: safeSpaceId, left: true, ended };
}

export async function endSpace({ spaceId, actorId }) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeActorId = toPositiveInt(actorId, 'user_id');
  const space = await prisma.community_space.findUnique({
    where: { id: safeSpaceId },
    select: { host_id: true, status: true },
  });
  if (!space) throw fail('Space not found', 404);
  if (space.host_id !== safeActorId) throw fail('Only the host can end this space', 403);
  if (space.status === 'ended') return { space_id: safeSpaceId, ended: true };
  await prisma.community_space.update({
    where: { id: safeSpaceId },
    data: { status: 'ended', ended_at: new Date() },
  });
  return { space_id: safeSpaceId, ended: true };
}

export async function setParticipantRole({ spaceId, actorId, targetUserId, role }) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeActorId = toPositiveInt(actorId, 'user_id');
  const safeTargetId = toPositiveInt(targetUserId, 'target_user_id');
  if (!ROLES.has(role) || role === 'host') throw fail('role must be speaker or listener');

  const space = await prisma.community_space.findUnique({
    where: { id: safeSpaceId },
    select: { host_id: true, status: true },
  });
  if (!space) throw fail('Space not found', 404);
  if (space.host_id !== safeActorId) throw fail('Only the host can change roles', 403);
  if (space.host_id === safeTargetId) throw fail("The host's role cannot be changed");

  const updated = await prisma.community_space_participant.updateMany({
    where: { space_id: safeSpaceId, user_id: safeTargetId, left_at: null },
    // Promoting to speaker clears any raised hand.
    data: { role, ...(role === 'speaker' ? { hand_raised: false } : {}) },
  });
  if (!updated.count) throw fail('Participant is not in this space', 404);
  return shapeSpace(await loadSpace(safeSpaceId));
}

export async function setHandRaised({ spaceId, userId, raised }) {
  const safeSpaceId = toPositiveInt(spaceId, 'space_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const updated = await prisma.community_space_participant.updateMany({
    where: { space_id: safeSpaceId, user_id: safeUserId, left_at: null },
    data: { hand_raised: Boolean(raised) },
  });
  if (!updated.count) throw fail('You are not in this space', 404);
  return shapeSpace(await loadSpace(safeSpaceId));
}

export function sendSpaceError(res, error, fallback = 'Space request failed') {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message || fallback });
}
