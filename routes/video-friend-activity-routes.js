// routes/video-friend-activity-routes.js
//
// #492 — "Friends are watching" discovery rail on the video watch page.
// Surfaces videos that the viewer's FRIENDS (mutual follows — A follows B *and* B follows A)
// have liked or watched. Live-in-progress watching is private: a friend's current session
// (watch_history ping within LIVE_WATCH_PRIVATE_MS) is omitted until it ages into "watched".
// Two hard privacy gates:
//   1. A friend's activity is only visible if THEY opted in (social_profile.share_video_activity,
//      default OFF — exposing watch history is sensitive).
//   2. The viewer can hide the rail entirely (social_profile.show_friend_video_activity, default ON).
//
// The follow graph lives on social_profile.profile_id; likes/watch_history are keyed on
// user.user_id — social_profile.user_id bridges the two.
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/** Recent watch_history pings stay private — after this window they surface as "watched". */
const LIVE_WATCH_PRIVATE_MS = 3 * 60 * 1000;
const MAX_VIDEOS = 24;
const FRIEND_ACTIVITY_PAGE_MAX = 24;
const PER_SIGNAL_SCAN = 400;                  // cap rows scanned per engagement signal
const ACTION_RANK = { liked: 2, watched: 1 };

// Same playability gate the recommendations endpoint uses (video-routes.js): transcoded,
// safe, on an active channel owned by a non-banned account.
function playableVideoWhere(candidateVideoIds) {
  return {
    video_id: { in: candidateVideoIds },
    status: 'safe',
    processing_status: 'done',
    hls_url: { not: null },
    channel: {
      is_active: true,
      user: {
        OR: [
          { social_profiles: { is: null } },
          { social_profiles: { is_banned: false } },
        ],
      },
    },
  };
}

// GET /video-friend-activity/preferences — the viewer's own two toggles.
router.get('/preferences', authenticateToken, async (req, res, next) => {
  try {
    const profileId = req.user.profile_id;
    if (!profileId) {
      return res.json({ successful: true, has_profile: false, share_video_activity: false, show_friend_video_activity: true });
    }
    const p = await prisma.social_profile.findUnique({
      where: { profile_id: profileId },
      select: { share_video_activity: true, show_friend_video_activity: true },
    });
    return res.json({
      successful: true,
      has_profile: true,
      share_video_activity: !!p?.share_video_activity,
      show_friend_video_activity: p?.show_friend_video_activity !== false,
    });
  } catch (err) { next(err); }
});

// PATCH /video-friend-activity/preferences — update either toggle. Booleans only.
router.patch('/preferences', authenticateToken, async (req, res, next) => {
  try {
    const profileId = req.user.profile_id;
    if (!profileId) return res.status(400).json({ successful: false, message: 'Social profile required.' });
    const data = {};
    if (typeof req.body?.share_video_activity === 'boolean') data.share_video_activity = req.body.share_video_activity;
    if (typeof req.body?.show_friend_video_activity === 'boolean') data.show_friend_video_activity = req.body.show_friend_video_activity;
    if (Object.keys(data).length === 0) return res.status(400).json({ successful: false, message: 'No valid preference provided.' });
    const updated = await prisma.social_profile.update({
      where: { profile_id: profileId },
      data,
      select: { share_video_activity: true, show_friend_video_activity: true },
    });
    return res.json({ successful: true, share_video_activity: updated.share_video_activity, show_friend_video_activity: updated.show_friend_video_activity });
  } catch (err) { next(err); }
});

// GET /video-friend-activity/feed?exclude=<currently-playing video_id>
router.get('/feed', authenticateToken, async (req, res, next) => {
  try {
    const { decodeCursor, encodeCursor, parsePageLimit } = await import('../utils/video-pagination.js');
    const limit = parsePageLimit(req.query.limit, 16, FRIEND_ACTIVITY_PAGE_MAX);
    let offset = 0;
    if (req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor);
      if (!Number.isInteger(decoded?.offset) || decoded.offset < 0) {
        return res.status(400).json({ successful: false, message: 'Invalid activity cursor.' });
      }
      offset = decoded.offset;
    }
    const profileId = req.user.profile_id;
    if (!profileId) return res.json({ successful: true, data: [] });

    // Gate 2: viewer opted out of seeing the rail.
    const me = await prisma.social_profile.findUnique({
      where: { profile_id: profileId },
      select: { show_friend_video_activity: true },
    });
    if (me && me.show_friend_video_activity === false) {
      return res.json({ successful: true, data: [], opted_out: true });
    }

    const excludeVideoId = Number(req.query.exclude) || null;

    // 1. Mutual follows: I follow them AND they follow me.
    // Only `accepted` edges count — a pending request to a private account is not a friendship,
    // and counting it would expose that account's watch history to someone it never accepted.
    const [iFollow, followMe] = await Promise.all([
      prisma.follower.findMany({ where: { follower_id: profileId, status: 'accepted' }, select: { following_id: true } }),
      prisma.follower.findMany({ where: { following_id: profileId, status: 'accepted' }, select: { follower_id: true } }),
    ]);
    const followMeSet = new Set(followMe.map((r) => r.follower_id));
    const mutualProfileIds = iFollow.map((r) => r.following_id).filter((id) => followMeSet.has(id));
    if (mutualProfileIds.length === 0) return res.json({ successful: true, data: [] });

    // 2. Gate 1: only friends who opted IN to sharing, and aren't banned.
    const friends = await prisma.social_profile.findMany({
      where: { profile_id: { in: mutualProfileIds }, share_video_activity: true, is_banned: false },
      select: { profile_id: true, user_id: true, display_name: true, handle: true, profile_pic_url: true },
    });
    if (friends.length === 0) return res.json({ successful: true, data: [] });
    const friendByUserId = new Map(friends.map((f) => [f.user_id, f]));
    const friendUserIds = friends.map((f) => f.user_id);

    // 3. Their like + watch signals (capped scan, newest first).
    const [likes, watches] = await Promise.all([
      prisma.video_likes.findMany({
        where: { user_id: { in: friendUserIds }, is_like: true },
        orderBy: { created_at: 'desc' }, take: PER_SIGNAL_SCAN,
        select: { user_id: true, video_id: true, created_at: true },
      }),
      prisma.watch_history.findMany({
        where: { user_id: { in: friendUserIds } },
        orderBy: { watched_at: 'desc' }, take: PER_SIGNAL_SCAN,
        select: { user_id: true, video_id: true, watched_at: true },
      }),
    ]);

    // 4. Collapse to ONE action per (video, friend): liked > watched.
    // Live sessions (watched_at within LIVE_WATCH_PRIVATE_MS) are omitted — not exposed as
    // "watching now". Once the ping ages out, the same row surfaces as "watched".
    const now = Date.now();
    const perVideo = new Map(); // videoId -> Map(userId -> { action, at })
    const upsertAction = (videoId, userId, action, at) => {
      if (!friendByUserId.has(userId)) return;
      if (excludeVideoId && videoId === excludeVideoId) return;
      let m = perVideo.get(videoId);
      if (!m) { m = new Map(); perVideo.set(videoId, m); }
      const prev = m.get(userId);
      const cand = { action, at: at ? new Date(at).getTime() : 0 };
      if (!prev || ACTION_RANK[action] > ACTION_RANK[prev.action]) m.set(userId, cand);
    };
    for (const w of watches) {
      const ageMs = now - new Date(w.watched_at).getTime();
      if (ageMs <= LIVE_WATCH_PRIVATE_MS) continue;
      upsertAction(w.video_id, w.user_id, 'watched', w.watched_at);
    }
    for (const l of likes) upsertAction(l.video_id, l.user_id, 'liked', l.created_at);

    const candidateVideoIds = [...perVideo.keys()];
    if (candidateVideoIds.length === 0) return res.json({ successful: true, data: [] });

    // 5. Keep only playable videos.
    const videos = await prisma.video.findMany({
      where: playableVideoWhere(candidateVideoIds),
      select: {
        video_id: true, title: true, thumbnail_url: true, duration_sec: true, views_count: true,
        public_id: true, slug: true, category: true, created_at: true,
        channel: { select: { channel_id: true, display_name: true, handle: true } },
      },
    });
    const videoById = new Map(videos.map((v) => [v.video_id, v]));

    // 6. Assemble + rank: more friends first, then most recent. No live-watching boost.
    const items = [];
    for (const [videoId, actionMap] of perVideo) {
      const v = videoById.get(videoId);
      if (!v) continue;
      const friendActions = [...actionMap.entries()].map(([userId, a]) => {
        const f = friendByUserId.get(userId);
        return {
          profile_id: f.profile_id, user_id: userId, display_name: f.display_name,
          handle: f.handle, avatar_url: f.profile_pic_url, action: a.action,
          atMs: a.at,
          // ISO so clients can show real relative time ("3 hours ago") without ms quirks.
          at: a.at > 0 ? new Date(a.at).toISOString() : null,
        };
      });
      friendActions.sort((a, b) => (ACTION_RANK[b.action] - ACTION_RANK[a.action]) || (b.atMs - a.atMs));
      const lastAt = friendActions.reduce((mx, f) => Math.max(mx, f.atMs), 0);
      items.push({
        video_id: v.video_id, title: v.title, thumbnail_url: v.thumbnail_url, duration_sec: v.duration_sec,
        views_count: v.views_count, public_id: v.public_id, slug: v.slug, category: v.category,
        channel: v.channel
          ? { channel_id: v.channel.channel_id, display_name: v.channel.display_name, handle: v.channel.handle }
          : null,
        friend_count: friendActions.length,
        watching_now: false,
        friends: friendActions.slice(0, 5).map(({ atMs, ...rest }) => rest),
        _rank: { friends: friendActions.length, at: lastAt },
      });
    }
    items.sort((a, b) =>
      (b._rank.friends - a._rank.friends) ||
      (b._rank.at - a._rank.at),
    );
    const bounded = items.slice(0, Math.max(MAX_VIDEOS, offset + limit + 1));
    const page = bounded.slice(offset, offset + limit);
    const hasMore = bounded.length > offset + limit;
    const data = page.map(({ _rank, ...rest }) => rest);
    return res.json({
      successful: true,
      data,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor({ offset: offset + data.length }) : null,
    });
  } catch (err) { next(err); }
});

// GET /video-friend-activity/channel-overlap?channel_id=
// Mutual friends who subscribe to the channel — watch-drawer "Your Circle" overlap banner.
// Privacy: respects the viewer's show_friend_video_activity opt-out AND the friend's
// share_video_activity opt-in, exactly as /feed does. Subscriptions are not public anywhere
// else on the platform, so listing them for a friend who never opted in (the flag defaults to
// false) would let any mutual follower rebuild that friend's subscription list by walking
// channel_id — which is the thing share_video_activity exists to prevent.
const CHANNEL_OVERLAP_CAP = 12;

router.get('/channel-overlap', authenticateToken, async (req, res, next) => {
  try {
    const profileId = req.user.profile_id;
    const channelId = Number(req.query.channel_id);
    if (!profileId) return res.json({ successful: true, data: [] });
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid channel_id.' });
    }

    const me = await prisma.social_profile.findUnique({
      where: { profile_id: profileId },
      select: { show_friend_video_activity: true },
    });
    if (me && me.show_friend_video_activity === false) {
      return res.json({ successful: true, data: [], opted_out: true });
    }

    // Accepted edges only — see the note on the /feed route above.
    const [iFollow, followMe] = await Promise.all([
      prisma.follower.findMany({ where: { follower_id: profileId, status: 'accepted' }, select: { following_id: true } }),
      prisma.follower.findMany({ where: { following_id: profileId, status: 'accepted' }, select: { follower_id: true } }),
    ]);
    const followMeSet = new Set(followMe.map((r) => r.follower_id));
    const mutualProfileIds = iFollow.map((r) => r.following_id).filter((id) => followMeSet.has(id));
    if (mutualProfileIds.length === 0) return res.json({ successful: true, data: [] });

    const friends = await prisma.social_profile.findMany({
      where: { profile_id: { in: mutualProfileIds }, share_video_activity: true, is_banned: false },
      select: { profile_id: true, user_id: true, display_name: true, handle: true, profile_pic_url: true },
    });
    const friendUserIds = friends.map((f) => f.user_id).filter(Boolean);
    if (friendUserIds.length === 0) return res.json({ successful: true, data: [] });

    const subs = await prisma.subscription.findMany({
      where: { channel_id: channelId, user_id: { in: friendUserIds } },
      select: { user_id: true },
    });
    const subUserIds = new Set(subs.map((s) => s.user_id));
    const data = friends
      .filter((f) => subUserIds.has(f.user_id))
      .slice(0, CHANNEL_OVERLAP_CAP)
      .map((f) => ({
        profile_id: f.profile_id,
        user_id: f.user_id,
        display_name: f.display_name,
        handle: f.handle,
        avatar_url: f.profile_pic_url,
      }));
    return res.json({ successful: true, data });
  } catch (err) { next(err); }
});

export default router;
