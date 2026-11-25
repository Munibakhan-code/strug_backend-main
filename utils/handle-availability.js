import prisma from './prisma-client.js';

export function sanitizeHandle(handle) {
  if (!handle) return '';
  return String(handle)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '');
}

// Cross-namespace handle uniqueness for the "main profile" identity handles: username,
// social_profile, vertical_profile and channel all share ONE pool. Streamer handles are
// deliberately NOT part of this pool anymore (#360, Option B) — a streamer "tag" is its own
// namespace (see checkStreamerHandleAvailability) and lives under a separate URL space
// (/live/@handle vs /c/handle), so a stream can carry your own identity handle even if that
// string is held by someone else's channel.
export async function checkHandleAvailability(handle, requestingUserId = null) {
  const sanitized = sanitizeHandle(handle);
  if (!sanitized) {
    return { available: false, namespace: null, reason: 'empty' };
  }

  const parsedUserId = requestingUserId ? Number(requestingUserId) : null;

  const lookups = [
    prisma.user.findFirst({
      where: { username: { equals: sanitized, mode: 'insensitive' } },
      select: { user_id: true }
    }).then(r => ({ model: 'user', row: r })),

    prisma.social_profile.findFirst({
      where: { handle: { equals: sanitized, mode: 'insensitive' } },
      select: { user_id: true }
    }).then(r => ({ model: 'social_profile', row: r })),

    prisma.vertical_profile.findFirst({
      where: { handle: { equals: sanitized, mode: 'insensitive' } },
      select: { user_id: true }
    }).then(r => ({ model: 'vertical_profile', row: r })),

    prisma.channel.findFirst({
      where: { handle: { equals: sanitized, mode: 'insensitive' } },
      select: { user_id: true }
    }).then(r => ({ model: 'channel', row: r }))
  ];

  const results = await Promise.all(lookups);

  for (const result of results) {
    if (result.row) {
      if (parsedUserId && result.row.user_id === parsedUserId) {
        continue;
      }
      return {
        available: false,
        namespace: result.model,
        takenBy: result.row.user_id
      };
    }
  }

  return { available: true };
}

// Streamer tags are their OWN namespace (#360, Option B): a tag only needs to be unique among
// streamers, not across the whole platform. Two streamers still can't share a tag, but a stream
// CAN reuse a handle that exists as a channel/social/vertical/username elsewhere (they resolve on
// different URL prefixes). Rows the requesting user already owns are ignored so re-running setup
// is idempotent.
export async function checkStreamerHandleAvailability(handle, requestingUserId = null) {
  const sanitized = sanitizeHandle(handle);
  if (!sanitized) {
    return { available: false, namespace: null, reason: 'empty' };
  }

  const parsedUserId = requestingUserId ? Number(requestingUserId) : null;

  const existing = await prisma.live_streamer_profile.findFirst({
    where: { handle: { equals: sanitized, mode: 'insensitive' } },
    select: { user_id: true }
  });

  if (existing && !(parsedUserId && existing.user_id === parsedUserId)) {
    return { available: false, namespace: 'live_streamer_profile', takenBy: existing.user_id };
  }

  return { available: true };
}

export async function enforceHandleUniqueness(req, res, next) {
  const handle = req.body?.handle ?? req.body?.username;
  if (!handle) {
    return res.status(400).json({ successful: false, message: 'Handle is required.' });
  }
  const userId = req.user?.user_id;
  const result = await checkHandleAvailability(handle, userId);
  if (!result.available) {
    return res.status(400).json({ successful: false, message: 'This handle is already taken.' });
  }
  next();
}