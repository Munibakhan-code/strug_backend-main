// routes/board-admin-product-routes.js
//
// Read-only Product data for the internal dashboards (strug-internal-dashboards →
// Product dashboard). Gated by the board identity + can_manage_members (the admin
// tier), matching Finance / Operations / Vertical Management / Customer Support /
// Analytics. Mounted at /board-admin/product. ALL endpoints are READ-ONLY.
//
// The Product dashboard is the product/usage/content view of the platform. The video
// + content-engagement domain is already exposed by /board-admin/analytics/content
// and the per-vertical product views compose FE-side from the users / operations /
// vertical-management / finance endpoints. The ONLY product surfaces not covered
// anywhere are the three social/communication product domains:
//
//   GET /engagement  social-feed (town_hall_post*), livestreaming (live_session /
//                    live_streamer_profile / live_vod / live_subscription / legacy
//                    stream+streamer) and messaging (chat_channel / chat_messages)
//                    engagement aggregates — counts + daily time-series. Messaging is
//                    COUNTS ONLY (no message content is read) — it's a usage signal,
//                    not a content surface.
//
// Everything else on the Product dashboard is FE-composed from existing board-admin
// endpoints, which keeps this router thin and dodges deploy risk for everything but
// the genuinely-new social/stream/messaging usage data.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('product', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const mapGroup = (rows, key) =>
  rows
    .map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);

// GET /engagement — social / streaming / messaging product usage. ?days (7..180,
// default 30) scopes the "recent" figures and the daily time-series window.
router.get('/engagement', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 180, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000); // bound in JS (no make_interval)
    const now = new Date();

    const [
      // ── SOCIAL FEED (town_hall) ──
      thPosts, thTopLevel, thReplies, thLikes, thReposts, thViews, thSaves,
      thViewSum, thRecent, thByMediaRaw, thTop, thDaily,
      // ── STREAMING (live_* + legacy stream/streamer) ──
      liveStreamers, legacyStreamers, liveSessions, liveLive, liveVods, liveClips,
      liveChat, liveSubs, liveActiveSubs, liveSchedules, liveStatusRaw, liveDaily,
      // ── MESSAGING (chat_*) — counts only ──
      chChannels, chMessages, chParticipants, chActiveChannels, chRecentMsgs,
      chByTypeRaw, chDaily,
    ] = await Promise.all([
      prisma.town_hall_post.count(),
      prisma.town_hall_post.count({ where: { parent_id: null } }),
      prisma.town_hall_post.count({ where: { parent_id: { not: null } } }),
      prisma.town_hall_post_like.count(),
      prisma.town_hall_repost.count(),
      prisma.town_hall_post_view.count(),
      prisma.town_hall_post_save.count(),
      prisma.town_hall_post.aggregate({ _sum: { view_count: true } }),
      prisma.town_hall_post.count({ where: { created_at: { gte: cutoff } } }),
      prisma.town_hall_post.groupBy({ by: ['media_type'], _count: { _all: true } }),
      prisma.town_hall_post.findMany({
        where: { parent_id: null },
        orderBy: { view_count: 'desc' },
        take: 8,
        select: { post_id: true, content: true, view_count: true, media_type: true, created_at: true, user_id: true },
      }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS posts
        FROM town_hall_post WHERE created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
      prisma.live_streamer_profile.count(),
      prisma.streamer.count(),
      prisma.live_session.count(),
      prisma.live_session.count({ where: { status: 'LIVE' } }),
      prisma.live_vod.count({ where: { is_clip: false } }),
      prisma.live_vod.count({ where: { is_clip: true } }),
      prisma.live_chat_message.count(),
      prisma.live_subscription.count(),
      prisma.live_subscription.count({ where: { status: 'active' } }),
      prisma.live_stream_schedule.count({ where: { is_cancelled: false, scheduled_at: { gte: now } } }),
      prisma.live_session.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS sessions
        FROM live_session WHERE created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
      prisma.chat_channel.count(),
      prisma.chat_messages.count(),
      prisma.chat_participants.count(),
      prisma.chat_channel.count({ where: { last_message_at: { gte: cutoff } } }),
      prisma.chat_messages.count({ where: { sent_at: { gte: cutoff } } }),
      prisma.chat_channel.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', sent_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS messages
        FROM chat_messages WHERE sent_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
    ]);

    res.json({
      days,
      social: {
        posts: thPosts,
        topLevel: thTopLevel,
        replies: thReplies,
        recentPosts: thRecent,
        likes: thLikes,
        reposts: thReposts,
        saves: thSaves,
        views: thViews,
        viewCount: num(thViewSum._sum.view_count),
        byMedia: mapGroup(thByMediaRaw, 'media_type'),
        topPosts: thTop.map((p) => ({
          post_id: p.post_id,
          // town hall is a PUBLIC feed; snippet is fine (cap length defensively)
          snippet: (p.content || '').slice(0, 90),
          views: num(p.view_count),
          media_type: p.media_type,
          created_at: p.created_at,
          user_id: p.user_id,
        })),
        daily: (thDaily || []).map((r) => ({ date: r.date, posts: num(r.posts) })),
        note: 'Social feed = the Town Hall post graph (town_hall_post + likes / reposts / saves / views). Views is the per-view table; view count is the cumulative counter on each post.',
      },
      streaming: {
        streamers: liveStreamers,
        legacyStreamers,
        sessions: liveSessions,
        live: liveLive,
        vods: liveVods,
        clips: liveClips,
        chatMessages: liveChat,
        subscriptions: liveSubs,
        activeSubscriptions: liveActiveSubs,
        upcomingScheduled: liveSchedules,
        byStatus: mapGroup(liveStatusRaw, 'status'),
        daily: (liveDaily || []).map((r) => ({ date: r.date, sessions: num(r.sessions) })),
        note: 'Live streaming = the live_session lifecycle under live_streamer_profile (sessions / live now / VODs / clips / chat / subscriptions). Legacy streamers are the older stream/streamer records.',
      },
      messaging: {
        channels: chChannels,
        messages: chMessages,
        participants: chParticipants,
        activeChannels: chActiveChannels,
        recentMessages: chRecentMsgs,
        byType: mapGroup(chByTypeRaw, 'type'),
        daily: (chDaily || []).map((r) => ({ date: r.date, messages: num(r.messages) })),
        note: 'Messaging usage is COUNTS ONLY — channels, participants and message volume (chat_channel / chat_messages / chat_participants). No message content is read; private conversations are never exposed.',
      },
    });
  } catch (err) {
    console.error('[board-admin/product] /engagement failed:', err);
    res.status(500).json({ error: 'Failed to load product engagement' });
  }
});

export default router;
