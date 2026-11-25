// routes/board-admin-creator-ops-routes.js
//
// Read-only Creator & Social Media Ops data for the internal dashboards
// (strug-internal-dashboards → Creator & Social Media Ops dashboard). Gated by the board
// identity + can_manage_members (the admin tier — exposes creator identity + emails),
// matching Finance / Marketing / Payments & Risks. Mounted at /board-admin/creator-ops.
// ALL endpoints READ-ONLY (payout approve / monetization approve / ban stay writes in the
// app live + social admin routes — surfaced here only as read-only queues).
//
// The creator stack is real and rich, so most of this is genuinely wireable:
//   live_streamer_profile / channel / social_profile   the three creator identities
//   town_hall_post(+_like/_view/_save/_repost)         the micro-post social graph
//   social_feed / social_interactions / follower       the social network + follow graph
//   video / revenue_share_log                          video content + ad-rev split
//   live_session / live_vod / live_stream_schedule     live streaming ops
//   live_chat_message / live_stream_guest              stream engagement
//   live_subscription(+_payment) / subscription        creator subscriptions (live $/mo + channel)
//   live_streamer_wallet / live_payout_request         creator monetization + payout queue
//   live_monetization_request                          monetization application queue
//   community_post(+poll/like)                          streamer community posts
//
// What genuinely does NOT exist (→ honest N/A in the dashboard): the private clipper-network
// payout model, creator tiers / levels, creator certification / badges, brand deals &
// sponsorships, a content-scheduling drafts queue (only live_stream_schedule for streams;
// town_hall_post.scheduled_at exists but no draft store), affiliate commission tiers, and
// invite / early-access codes. Write-actions (approve payout, approve monetization, ban a
// creator, AI moderation / appeals) stay N/A on this read-only surface.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('creator-ops', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const mapGroup = (rows, key) =>
  rows.map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);

const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};
async function userSummaries(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, name: true, username: true, email: true },
  });
  const map = {};
  for (const u of users) map[u.user_id] = { user_id: u.user_id, name: u.name, username: u.username, email: decryptEmail(u.email) };
  return map;
}
// Map social_profile.profile_id → owning user summary (follower graph is keyed on profile_id).
async function profileSummaries(profileIds) {
  const unique = [...new Set(profileIds.filter((x) => x != null))];
  if (!unique.length) return {};
  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: unique } },
    select: { profile_id: true, user_id: true, handle: true, display_name: true, is_verified: true },
  });
  const users = await userSummaries(profiles.map((p) => p.user_id));
  const map = {};
  for (const p of profiles) {
    map[p.profile_id] = {
      profile_id: p.profile_id, handle: p.handle, display_name: p.display_name,
      is_verified: p.is_verified, owner: users[p.user_id] || { user_id: p.user_id },
    };
  }
  return map;
}
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /overview — the creator-ecosystem rollup.  ?days=N (velocity window, default 30)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    const [
      streamers, channels, socialProfiles,
      streamersVerified, channelsVerified, socialVerified,
      monetByStatus,
      townPosts, videos, liveSessions, communityPosts, feedPosts,
      townLikes, townViewsAgg, townReposts, followers, activeSubs, channelSubs,
      revShare, subPay, giftAgg, streamerWalletAgg, payoutPending, payoutPendingAmt,
      shadowBanned, banned, nsfwVideos,
    ] = await Promise.all([
      prisma.live_streamer_profile.count(),
      prisma.channel.count(),
      prisma.social_profile.count(),
      prisma.live_streamer_profile.count({ where: { is_verified: true } }),
      prisma.channel.count({ where: { is_verified: true } }),
      prisma.social_profile.count({ where: { is_verified: true } }),
      prisma.live_streamer_profile.groupBy({ by: ['monetization_status'], _count: { _all: true } }),
      prisma.town_hall_post.count(),
      prisma.video.count(),
      prisma.live_session.count(),
      prisma.community_post.count(),
      prisma.social_feed.count(),
      prisma.town_hall_post_like.count(),
      prisma.town_hall_post.aggregate({ _sum: { view_count: true } }),
      prisma.town_hall_repost.count(),
      prisma.follower.count(),
      prisma.live_subscription.count({ where: { status: 'active' } }),
      prisma.subscription.count(),
      prisma.revenue_share_log.aggregate({ _sum: { total_earned: true, creator_share: true, platform_share: true } }),
      prisma.live_subscription_payment.aggregate({ _sum: { amount_cents: true, creator_share: true, platform_share: true } }),
      prisma.live_gift.aggregate({ _sum: { fiat_cents: true, creator_share: true, platform_share: true } }),
      prisma.live_streamer_wallet.aggregate({ _sum: { balance: true } }),
      prisma.live_payout_request.count({ where: { status: 'PENDING' } }),
      prisma.live_payout_request.aggregate({ _sum: { amount: true }, where: { status: 'PENDING' } }),
      prisma.social_profile.count({ where: { is_shadow_banned: true } }),
      prisma.social_profile.count({ where: { is_banned: true } }),
      prisma.video.count({ where: { is_nsfw: true } }),
    ]);

    // Content velocity: town-hall posts + videos + live sessions per day.
    const [townDaily, videoDaily, sessionDaily] = await Promise.all([
      prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM town_hall_post WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`,
      prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM video WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`,
      prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM live_session WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`,
    ]);
    const dayMap = {};
    const stamp = (rows, key) => rows.forEach((r) => {
      const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      dayMap[d] = dayMap[d] || { day: d, posts: 0, videos: 0, sessions: 0 };
      dayMap[d][key] = num(r.n);
    });
    stamp(townDaily, 'posts'); stamp(videoDaily, 'videos'); stamp(sessionDaily, 'sessions');
    const daily = Object.values(dayMap).sort((a, b) => (a.day < b.day ? -1 : 1));

    res.json({
      days,
      creators: {
        streamers, channels, socialProfiles,
        total: streamers + channels + socialProfiles,
        verified: { streamers: streamersVerified, channels: channelsVerified, social: socialVerified,
          total: streamersVerified + channelsVerified + socialVerified },
        monetization: mapGroup(monetByStatus, 'monetization_status'),
      },
      content: { townHallPosts: townPosts, videos, liveSessions, communityPosts, feedPosts,
        total: townPosts + videos + liveSessions + communityPosts + feedPosts },
      engagement: {
        townHallLikes: townLikes, townHallViews: num(townViewsAgg._sum.view_count), townHallReposts: townReposts,
        followers, liveSubscriptions: activeSubs, channelSubscriptions: channelSubs,
      },
      monetization: {
        adRevenue: { total: num(revShare._sum.total_earned), creatorShare: num(revShare._sum.creator_share), platformShare: num(revShare._sum.platform_share) },
        subRevenue: { total: num(subPay._sum.amount_cents) / 100, creatorShare: num(subPay._sum.creator_share), platformShare: num(subPay._sum.platform_share) },
        giftRevenue: { total: num(giftAgg._sum.fiat_cents) / 100, creatorShare: num(giftAgg._sum.creator_share), platformShare: num(giftAgg._sum.platform_share) },
        streamerWalletBalance: num(streamerWalletAgg._sum.balance),
        pendingPayouts: { count: payoutPending, amount: num(payoutPendingAmt._sum.amount) },
      },
      safety: { shadowBanned, banned, nsfwVideos },
      daily,
      note: 'Creator overview = a read-only rollup across the creator stack (streamers / channels / social profiles, town-hall + video + live content, engagement graph, ad + subscription + gift revenue, payout queue, safety flags). All creator writes (approve payout / monetization, ban) live in the app admin routes.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load creator overview' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /creators — the creator roster.  ?type=streamer|channel|social (default streamer)
//   ?verified=true ?monetization=APPROVED (streamer only) ?search= ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/creators', async (req, res) => {
  try {
    const type = pick(req.query.type, ['streamer', 'channel', 'social'], 'streamer');
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;
    const verified = req.query.verified === 'true' ? true : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    if (type === 'streamer') {
      const where = {};
      if (verified) where.is_verified = true;
      if (req.query.monetization) where.monetization_status = String(req.query.monetization);
      if (search) where.OR = [
        { handle: { contains: search, mode: 'insensitive' } },
        { display_name: { contains: search, mode: 'insensitive' } },
      ];
      const [total, rows, byMonet] = await Promise.all([
        prisma.live_streamer_profile.count({ where }),
        prisma.live_streamer_profile.findMany({
          where, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: {
            streamer_id: true, user_id: true, handle: true, display_name: true,
            is_verified: true, is_nsfw: true, is_active: true, monetization_status: true, created_at: true,
            _count: { select: { sessions: true, subscriptions: true, vods: true, community_posts: true } },
          },
        }),
        prisma.live_streamer_profile.groupBy({ by: ['monetization_status'], _count: { _all: true }, where }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
        byMonetization: mapGroup(byMonet, 'monetization_status'),
        filters: { verified: verified || null, monetization: req.query.monetization || null, search: search || null },
        creators: rows.map((s) => ({
          id: s.streamer_id, kind: 'streamer', handle: s.handle, display_name: s.display_name,
          is_verified: s.is_verified, is_nsfw: s.is_nsfw, is_active: s.is_active,
          monetization_status: s.monetization_status, created_at: s.created_at,
          stats: { sessions: s._count.sessions, subscribers: s._count.subscriptions, vods: s._count.vods, communityPosts: s._count.community_posts },
          owner: users[s.user_id] || { user_id: s.user_id },
        })),
      });
    }

    if (type === 'channel') {
      const where = {};
      if (verified) where.is_verified = true;
      if (search) where.OR = [
        { handle: { contains: search, mode: 'insensitive' } },
        { display_name: { contains: search, mode: 'insensitive' } },
      ];
      const [total, rows] = await Promise.all([
        prisma.channel.count({ where }),
        prisma.channel.findMany({
          where, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: {
            channel_id: true, user_id: true, handle: true, display_name: true, content_niche: true,
            is_verified: true, is_active: true, created_at: true,
            _count: { select: { videos: true, subscriptions: true } },
          },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
        filters: { verified: verified || null, search: search || null },
        creators: rows.map((c) => ({
          id: c.channel_id, kind: 'channel', handle: c.handle, display_name: c.display_name,
          content_niche: c.content_niche, is_verified: c.is_verified, is_active: c.is_active, created_at: c.created_at,
          stats: { videos: c._count.videos, subscribers: c._count.subscriptions },
          owner: users[c.user_id] || { user_id: c.user_id },
        })),
      });
    }

    // social profile
    const where = {};
    if (verified) where.is_verified = true;
    if (search) where.OR = [
      { handle: { contains: search, mode: 'insensitive' } },
      { display_name: { contains: search, mode: 'insensitive' } },
    ];
    const [total, rows] = await Promise.all([
      prisma.social_profile.count({ where }),
      prisma.social_profile.findMany({
        where, orderBy: { created_at: 'desc' }, skip, take: limit,
        select: {
          profile_id: true, user_id: true, handle: true, display_name: true,
          is_verified: true, is_private: true, is_shadow_banned: true, is_banned: true,
          verification_type: true, created_at: true,
          _count: { select: { posts: true, followers: { where: { status: 'accepted' } }, following: { where: { status: 'accepted' } } } },
        },
      }),
    ]);
    const users = await userSummaries(rows.map((r) => r.user_id));
    return res.json({
      type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
      filters: { verified: verified || null, search: search || null },
      creators: rows.map((p) => ({
        id: p.profile_id, kind: 'social', handle: p.handle, display_name: p.display_name,
        is_verified: p.is_verified, is_private: p.is_private, is_shadow_banned: p.is_shadow_banned,
        is_banned: p.is_banned, verification_type: p.verification_type, created_at: p.created_at,
        stats: { posts: p._count.posts, followers: p._count.followers, following: p._count.following },
        owner: users[p.user_id] || { user_id: p.user_id },
      })),
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /creators failed:', err);
    res.status(500).json({ error: 'Failed to load creators' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /content — the content feed.  ?type=townhall|video|live|community (default townhall)
//   ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/content', async (req, res) => {
  try {
    const type = pick(req.query.type, ['townhall', 'video', 'live', 'community'], 'townhall');
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    if (type === 'townhall') {
      const [total, rows] = await Promise.all([
        prisma.town_hall_post.count(),
        prisma.town_hall_post.findMany({
          orderBy: { created_at: 'desc' }, skip, take: limit,
          select: {
            post_id: true, user_id: true, content: true, media_type: true, view_count: true,
            parent_id: true, quote_post_id: true, created_at: true,
            _count: { select: { likes: true, reposts: true, saves: true, replies: true } },
          },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
        items: rows.map((p) => ({
          id: p.post_id, content: p.content, media_type: p.media_type, view_count: p.view_count,
          is_reply: p.parent_id != null, is_quote: p.quote_post_id != null, created_at: p.created_at,
          stats: { likes: p._count.likes, reposts: p._count.reposts, saves: p._count.saves, replies: p._count.replies },
          author: users[p.user_id] || { user_id: p.user_id },
        })),
        note: 'Town Hall = the 280-char micro-post graph (posts / replies / quotes) with like / repost / save / view counts.',
      });
    }

    if (type === 'video') {
      const [total, byStatus, byType, rows] = await Promise.all([
        prisma.video.count(),
        prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.video.groupBy({ by: ['video_type'], _count: { _all: true } }),
        prisma.video.findMany({
          orderBy: { created_at: 'desc' }, skip, take: limit,
          select: {
            video_id: true, channel_id: true, title: true, video_type: true, status: true,
            views_count: true, duration_sec: true, is_monetizable: true, ad_revenue: true,
            is_nsfw: true, safety_score: true, category: true, created_at: true,
            channel: { select: { handle: true, display_name: true, user_id: true } },
          },
        }),
      ]);
      return res.json({
        type, total, byStatus: mapGroup(byStatus, 'status'), byType: mapGroup(byType, 'video_type'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        items: rows.map((v) => ({
          id: v.video_id, title: v.title, video_type: v.video_type, status: v.status,
          views: v.views_count, duration_sec: v.duration_sec, is_monetizable: v.is_monetizable,
          ad_revenue: num(v.ad_revenue), is_nsfw: v.is_nsfw, safety_score: v.safety_score,
          category: v.category, created_at: v.created_at,
          channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null,
        })),
        note: 'Videos = the channel video catalog with status / views / duration / ad-revenue and safety flags.',
      });
    }

    if (type === 'live') {
      const [total, byStatus, rows] = await Promise.all([
        prisma.live_session.count(),
        prisma.live_session.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.live_session.findMany({
          orderBy: { created_at: 'desc' }, skip, take: limit,
          select: {
            session_id: true, title: true, status: true, started_at: true, ended_at: true, created_at: true,
            streamer: { select: { handle: true, display_name: true } },
            _count: { select: { chat_messages: true, guests: true, vods: true } },
          },
        }),
      ]);
      return res.json({
        type, total, byStatus: mapGroup(byStatus, 'status'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        items: rows.map((s) => ({
          id: s.session_id, title: s.title, status: s.status,
          started_at: s.started_at, ended_at: s.ended_at, created_at: s.created_at,
          streamer: s.streamer ? { handle: s.streamer.handle, display_name: s.streamer.display_name } : null,
          stats: { chatMessages: s._count.chat_messages, guests: s._count.guests, vods: s._count.vods },
        })),
        note: 'Live sessions = every broadcast (IDLE→LIVE→ENDED) with chat / guest / VOD counts.',
      });
    }

    // community
    const [total, pollCount, rows] = await Promise.all([
      prisma.community_post.count(),
      prisma.community_post.count({ where: { is_poll: true } }),
      prisma.community_post.findMany({
        orderBy: { created_at: 'desc' }, skip, take: limit,
        select: {
          post_id: true, content: true, image_url: true, is_poll: true, created_at: true,
          streamer: { select: { handle: true, display_name: true } },
          _count: { select: { likes: true, poll_options: true } },
        },
      }),
    ]);
    return res.json({
      type, total, polls: pollCount,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      items: rows.map((p) => ({
        id: p.post_id, content: p.content, has_image: !!p.image_url, is_poll: p.is_poll, created_at: p.created_at,
        streamer: p.streamer ? { handle: p.streamer.handle, display_name: p.streamer.display_name } : null,
        stats: { likes: p._count.likes, pollOptions: p._count.poll_options },
      })),
      note: 'Community posts = streamer-channel posts + polls (with like + poll-option counts).',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /content failed:', err);
    res.status(500).json({ error: 'Failed to load content' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /engagement — ?mode=followers|likes|views|topposts|topvideos|comments  ?days=N
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/engagement', async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['followers', 'likes', 'views', 'topposts', 'topvideos', 'comments'], 'followers');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    if (mode === 'followers') {
      const [total, recent, topRaw] = await Promise.all([
        prisma.follower.count(),
        prisma.follower.count({ where: { created_at: { gte: cutoff } } }),
        prisma.follower.groupBy({ by: ['following_id'], _count: { _all: true }, orderBy: { _count: { following_id: 'desc' } }, take: 15 }),
      ]);
      const profs = await profileSummaries(topRaw.map((t) => t.following_id));
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM follower WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days, totals: { follows: total, recent },
        topFollowed: topRaw.map((t) => ({ profile: profs[t.following_id] || { profile_id: t.following_id }, followers: num(t._count._all) })),
        daily: daily.map((d) => ({ day: d.day, follows: num(d.n) })),
        note: 'Follower graph = the social_profile follow edges (total, new-in-window, most-followed profiles, daily new follows).',
      });
    }

    if (mode === 'likes') {
      const [townLikes, townRecent, reactions, byReaction, communityLikes, videoLikes] = await Promise.all([
        prisma.town_hall_post_like.count(),
        prisma.town_hall_post_like.count({ where: { created_at: { gte: cutoff } } }),
        prisma.social_interactions.count(),
        prisma.social_interactions.groupBy({ by: ['reaction_type'], _count: { _all: true } }),
        prisma.community_post_like.count(),
        prisma.video_likes.count(),
      ]);
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM town_hall_post_like WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days,
        totals: { townHallLikes: townLikes, townHallLikesRecent: townRecent, socialReactions: reactions,
          communityLikes, videoLikes },
        byReaction: mapGroup(byReaction, 'reaction_type'),
        daily: daily.map((d) => ({ day: d.day, likes: num(d.n) })),
        note: 'Likes & reactions across town-hall likes, social-feed reactions, community likes and video likes.',
      });
    }

    if (mode === 'views') {
      const [townViews, videoViewsAgg, watchAgg, storyViews, byDevice] = await Promise.all([
        prisma.town_hall_post.aggregate({ _sum: { view_count: true } }),
        prisma.video.aggregate({ _sum: { views_count: true } }),
        prisma.video_analytics.aggregate({ _sum: { watch_time_sec: true }, _count: { _all: true } }),
        prisma.story_view.count(),
        prisma.video_analytics.groupBy({ by: ['device_type'], _count: { _all: true } }),
      ]);
      return res.json({
        mode, days,
        totals: {
          townHallViews: num(townViews._sum.view_count),
          videoViews: num(videoViewsAgg._sum.views_count),
          watchTimeSec: num(watchAgg._sum.watch_time_sec),
          analyticsEvents: num(watchAgg._count._all),
          storyViews,
        },
        byDevice: mapGroup(byDevice, 'device_type'),
        note: 'Views & watch time = town-hall post views, video view counts, video_analytics watch-time (+device split) and story views.',
      });
    }

    if (mode === 'topposts') {
      const rows = await prisma.town_hall_post.findMany({
        orderBy: [{ likes: { _count: 'desc' } }, { view_count: 'desc' }], take: 20,
        select: { post_id: true, user_id: true, content: true, view_count: true, created_at: true,
          _count: { select: { likes: true, reposts: true, replies: true } } },
      });
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        mode,
        posts: rows.map((p) => ({ id: p.post_id, content: p.content, views: p.view_count, created_at: p.created_at,
          stats: { likes: p._count.likes, reposts: p._count.reposts, replies: p._count.replies },
          author: users[p.user_id] || { user_id: p.user_id } })),
        note: 'Top posts = town-hall posts ranked by like count then view count.',
      });
    }

    if (mode === 'topvideos') {
      const rows = await prisma.video.findMany({
        where: { status: 'published' }, orderBy: { views_count: 'desc' }, take: 20,
        select: { video_id: true, title: true, views_count: true, ad_revenue: true, video_type: true,
          duration_sec: true, created_at: true, channel: { select: { handle: true, display_name: true } } },
      });
      return res.json({
        mode,
        videos: rows.map((v) => ({ id: v.video_id, title: v.title, views: v.views_count, ad_revenue: num(v.ad_revenue),
          video_type: v.video_type, duration_sec: v.duration_sec, created_at: v.created_at,
          channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null })),
        note: 'Top videos = published videos ranked by view count (with ad-revenue).',
      });
    }

    // comments
    const [socialComments, videoComments, townReplies, liveChat] = await Promise.all([
      prisma.social_comments.count(),
      prisma.video_comments.count(),
      prisma.town_hall_post.count({ where: { parent_id: { not: null } } }),
      prisma.live_chat_message.count(),
    ]);
    return res.json({
      mode,
      totals: { socialComments, videoComments, townHallReplies: townReplies, liveChatMessages: liveChat,
        total: socialComments + videoComments + townReplies + liveChat },
      note: 'Comments = social-feed comments, video comments, town-hall replies and live-chat messages across the creator surfaces.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /engagement failed:', err);
    res.status(500).json({ error: 'Failed to load engagement' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /streaming — ?mode=live|history|scheduled|guests|chat  ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/streaming', async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['live', 'history', 'scheduled', 'guests', 'chat'], 'live');
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    const streamerSel = { streamer: { select: { handle: true, display_name: true } } };

    if (mode === 'live' || mode === 'history') {
      const where = mode === 'live' ? { status: 'LIVE' } : {};
      const [total, byStatus, liveNow, rows] = await Promise.all([
        prisma.live_session.count({ where }),
        prisma.live_session.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.live_session.count({ where: { status: 'LIVE' } }),
        prisma.live_session.findMany({
          where, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { session_id: true, title: true, status: true, started_at: true, ended_at: true, created_at: true,
            ...streamerSel, _count: { select: { chat_messages: true, guests: true, vods: true } } },
        }),
      ]);
      return res.json({
        mode, total, liveNow, byStatus: mapGroup(byStatus, 'status'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        sessions: rows.map((s) => ({ id: s.session_id, title: s.title, status: s.status,
          started_at: s.started_at, ended_at: s.ended_at, created_at: s.created_at,
          streamer: s.streamer ? { handle: s.streamer.handle, display_name: s.streamer.display_name } : null,
          stats: { chatMessages: s._count.chat_messages, guests: s._count.guests, vods: s._count.vods } })),
        note: mode === 'live' ? 'Live now = sessions currently in LIVE status.' : 'Session history = all broadcasts, newest first.',
      });
    }

    if (mode === 'scheduled') {
      const [total, upcoming, rows] = await Promise.all([
        prisma.live_stream_schedule.count(),
        prisma.live_stream_schedule.count({ where: { is_cancelled: false, scheduled_at: { gte: new Date() } } }),
        prisma.live_stream_schedule.findMany({
          orderBy: { scheduled_at: 'desc' }, skip, take: limit,
          select: { schedule_id: true, title: true, scheduled_at: true, is_cancelled: true, created_at: true, ...streamerSel },
        }),
      ]);
      return res.json({
        mode, total, upcoming, pagination: { page, limit, pages: Math.ceil(total / limit) },
        schedules: rows.map((s) => ({ id: s.schedule_id, title: s.title, scheduled_at: s.scheduled_at,
          is_cancelled: s.is_cancelled, created_at: s.created_at,
          streamer: s.streamer ? { handle: s.streamer.handle, display_name: s.streamer.display_name } : null })),
        note: 'Scheduled streams = the upcoming-broadcast schedule (live_stream_schedule).',
      });
    }

    if (mode === 'guests') {
      const [total, byStatus, rows] = await Promise.all([
        prisma.live_stream_guest.count(),
        prisma.live_stream_guest.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.live_stream_guest.findMany({
          orderBy: { guest_id: 'desc' }, skip, take: limit,
          select: { guest_id: true, user_id: true, status: true, joined_at: true, left_at: true,
            session: { select: { title: true, ...streamerSel } } },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        mode, total, byStatus: mapGroup(byStatus, 'status'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        guests: rows.map((g) => ({ id: g.guest_id, status: g.status, joined_at: g.joined_at, left_at: g.left_at,
          session_title: g.session?.title || null,
          streamer: g.session?.streamer ? { handle: g.session.streamer.handle, display_name: g.session.streamer.display_name } : null,
          guest: users[g.user_id] || { user_id: g.user_id } })),
        note: 'Stream guests = co-host / guest invites on live sessions (INVITED→JOINED→LEFT).',
      });
    }

    // chat volume
    const [total, topRaw] = await Promise.all([
      prisma.live_chat_message.count(),
      prisma.live_chat_message.groupBy({ by: ['session_id'], _count: { _all: true }, orderBy: { _count: { session_id: 'desc' } }, take: 15 }),
    ]);
    const sessions = await prisma.live_session.findMany({
      where: { session_id: { in: topRaw.map((t) => t.session_id) } },
      select: { session_id: true, title: true, status: true, streamer: { select: { handle: true, display_name: true } } },
    });
    const sMap = Object.fromEntries(sessions.map((s) => [s.session_id, s]));
    return res.json({
      mode, totals: { messages: total },
      topSessions: topRaw.map((t) => ({ session_id: t.session_id, title: sMap[t.session_id]?.title || `Session #${t.session_id}`,
        status: sMap[t.session_id]?.status || null,
        streamer: sMap[t.session_id]?.streamer ? { handle: sMap[t.session_id].streamer.handle, display_name: sMap[t.session_id].streamer.display_name } : null,
        messages: num(t._count._all) })),
      note: 'Live chat volume = live_chat_message totals and the busiest sessions by message count.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /streaming failed:', err);
    res.status(500).json({ error: 'Failed to load streaming ops' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /monetization — ?mode=overview|ads|subs|wallets|payouts|requests  ?days= ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/monetization', async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['overview', 'ads', 'subs', 'wallets', 'payouts', 'requests'], 'overview');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    if (mode === 'overview') {
      const [revShare, subPay, giftAgg, walletAgg, payoutByStatus, monetByStatus] = await Promise.all([
        prisma.revenue_share_log.aggregate({ _sum: { total_earned: true, creator_share: true, platform_share: true }, _count: { _all: true } }),
        prisma.live_subscription_payment.aggregate({ _sum: { amount_cents: true, creator_share: true, platform_share: true }, _count: { _all: true } }),
        prisma.live_gift.aggregate({ _sum: { fiat_cents: true, creator_share: true, platform_share: true }, _count: { _all: true } }),
        prisma.live_streamer_wallet.aggregate({ _sum: { balance: true }, _count: { _all: true } }),
        prisma.live_payout_request.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
        prisma.live_monetization_request.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);
      return res.json({
        mode,
        adRevenue: { events: num(revShare._count._all), total: num(revShare._sum.total_earned), creatorShare: num(revShare._sum.creator_share), platformShare: num(revShare._sum.platform_share) },
        subRevenue: { payments: num(subPay._count._all), total: num(subPay._sum.amount_cents) / 100, creatorShare: num(subPay._sum.creator_share), platformShare: num(subPay._sum.platform_share) },
        giftRevenue: { gifts: num(giftAgg._count._all), total: num(giftAgg._sum.fiat_cents) / 100, creatorShare: num(giftAgg._sum.creator_share), platformShare: num(giftAgg._sum.platform_share) },
        wallets: { count: num(walletAgg._count._all), balance: num(walletAgg._sum.balance) },
        payouts: payoutByStatus.map((p) => ({ name: p.status, count: num(p._count._all), amount: num(p._sum.amount) })).sort((a, b) => b.count - a.count),
        monetizationRequests: mapGroup(monetByStatus, 'status'),
        note: 'Monetization overview = creator ad-revenue split (revenue_share_log), live-subscription revenue (live_subscription_payment), live-gift revenue (live_gift), streamer wallet balances and the payout / monetization request queues.',
      });
    }

    if (mode === 'ads') {
      const agg = await prisma.revenue_share_log.aggregate({ _sum: { total_earned: true, creator_share: true, platform_share: true }, _count: { _all: true } });
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day,
        SUM(total_earned)::float AS total, SUM(creator_share)::float AS creator, SUM(platform_share)::float AS platform
        FROM revenue_share_log WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      const topRaw = await prisma.revenue_share_log.groupBy({ by: ['video_id'], _sum: { total_earned: true, creator_share: true }, orderBy: { _sum: { total_earned: 'desc' } }, take: 15 });
      const vids = await prisma.video.findMany({ where: { video_id: { in: topRaw.map((t) => t.video_id) } }, select: { video_id: true, title: true, channel: { select: { handle: true, display_name: true } } } });
      const vMap = Object.fromEntries(vids.map((v) => [v.video_id, v]));
      return res.json({
        mode, days,
        totals: { events: num(agg._count._all), total: num(agg._sum.total_earned), creatorShare: num(agg._sum.creator_share), platformShare: num(agg._sum.platform_share) },
        daily: daily.map((d) => ({ day: d.day, total: num(d.total), creator: num(d.creator), platform: num(d.platform) })),
        topVideos: topRaw.map((t) => ({ video_id: t.video_id, title: vMap[t.video_id]?.title || `Video #${t.video_id}`,
          channel: vMap[t.video_id]?.channel ? { handle: vMap[t.video_id].channel.handle, display_name: vMap[t.video_id].channel.display_name } : null,
          total: num(t._sum.total_earned), creator: num(t._sum.creator_share) })),
        note: 'Ad revenue = the video ad-revenue-share ledger (revenue_share_log): total earned split into creator / platform share, daily series + top-earning videos.',
      });
    }

    if (mode === 'subs') {
      const agg = await prisma.live_subscription_payment.aggregate({ _sum: { amount_cents: true, creator_share: true, platform_share: true }, _count: { _all: true } });
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day,
        SUM(amount_cents)::float / 100 AS total, SUM(creator_share)::float AS creator, SUM(platform_share)::float AS platform
        FROM live_subscription_payment WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      const topRaw = await prisma.live_subscription_payment.groupBy({ by: ['streamer_id'], _sum: { creator_share: true, amount_cents: true }, _count: { _all: true }, orderBy: { _sum: { creator_share: 'desc' } }, take: 15 });
      const streamers = await prisma.live_streamer_profile.findMany({ where: { streamer_id: { in: topRaw.map((t) => t.streamer_id) } }, select: { streamer_id: true, handle: true, display_name: true } });
      const sMap = Object.fromEntries(streamers.map((s) => [s.streamer_id, s]));
      return res.json({
        mode, days,
        totals: { payments: num(agg._count._all), total: num(agg._sum.amount_cents) / 100, creatorShare: num(agg._sum.creator_share), platformShare: num(agg._sum.platform_share) },
        daily: daily.map((d) => ({ day: d.day, total: num(d.total), creator: num(d.creator), platform: num(d.platform) })),
        topStreamers: topRaw.map((t) => ({ streamer_id: t.streamer_id, handle: sMap[t.streamer_id]?.handle || null,
          display_name: sMap[t.streamer_id]?.display_name || `Streamer #${t.streamer_id}`,
          payments: num(t._count._all), total: num(t._sum.amount_cents) / 100, creator: num(t._sum.creator_share) })),
        note: 'Subscription revenue = live_subscription_payment invoices (the $/mo creator subs): amount split into creator / platform share, daily series + top-earning streamers.',
      });
    }

    if (mode === 'wallets') {
      const [count, sum, rows] = await Promise.all([
        prisma.live_streamer_wallet.count(),
        prisma.live_streamer_wallet.aggregate({ _sum: { balance: true } }),
        prisma.live_streamer_wallet.findMany({
          orderBy: { balance: 'desc' }, skip, take: limit,
          select: { wallet_id: true, user_id: true, balance: true, currency: true,
            streamer: { select: { handle: true, display_name: true } } },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        mode, summary: { count, balance: num(sum._sum.balance) },
        pagination: { page, limit, pages: Math.ceil(count / limit) },
        wallets: rows.map((w) => ({ wallet_id: w.wallet_id, balance: num(w.balance), currency: w.currency,
          streamer: w.streamer ? { handle: w.streamer.handle, display_name: w.streamer.display_name } : null,
          owner: users[w.user_id] || { user_id: w.user_id } })),
        note: 'Creator wallets = live_streamer_wallet sub-revenue balances (top balances first).',
      });
    }

    if (mode === 'payouts') {
      const where = {};
      if (req.query.status) where.status = String(req.query.status);
      const [total, byStatus, rows] = await Promise.all([
        prisma.live_payout_request.count({ where }),
        prisma.live_payout_request.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
        prisma.live_payout_request.findMany({
          where, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { payout_id: true, amount: true, status: true, admin_note: true, created_at: true,
            resolved_at: true, paid_at: true, streamer: { select: { handle: true, display_name: true, user_id: true } } },
        }),
      ]);
      return res.json({
        mode, total, filters: { status: req.query.status || null },
        byStatus: byStatus.map((s) => ({ name: s.status, count: num(s._count._all), amount: num(s._sum.amount) })).sort((a, b) => b.count - a.count),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        payouts: rows.map((p) => ({ id: p.payout_id, amount: num(p.amount), status: p.status, admin_note: p.admin_note,
          created_at: p.created_at, resolved_at: p.resolved_at, paid_at: p.paid_at,
          streamer: p.streamer ? { handle: p.streamer.handle, display_name: p.streamer.display_name } : null })),
        note: 'Payout queue = live_payout_request rows (PENDING→APPROVED/REJECTED→PAID). READ-ONLY here — approving / triggering a payout is a write handled in the app live-payout admin route.',
      });
    }

    // requests (monetization applications)
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    const [total, byStatus, rows] = await Promise.all([
      prisma.live_monetization_request.count({ where }),
      prisma.live_monetization_request.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.live_monetization_request.findMany({
        where, orderBy: { applied_at: 'desc' }, skip, take: limit,
        select: { request_id: true, status: true, admin_note: true, applied_at: true, resolved_at: true,
          streamer: { select: { handle: true, display_name: true } } },
      }),
    ]);
    return res.json({
      mode, total, filters: { status: req.query.status || null },
      byStatus: mapGroup(byStatus, 'status'),
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      requests: rows.map((r) => ({ id: r.request_id, status: r.status, admin_note: r.admin_note,
        applied_at: r.applied_at, resolved_at: r.resolved_at,
        streamer: r.streamer ? { handle: r.streamer.handle, display_name: r.streamer.display_name } : null })),
      note: 'Monetization requests = live_monetization_request applications (PENDING→APPROVED/REJECTED). READ-ONLY — the approve / reject decision is a write in the app live-admin route.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /monetization failed:', err);
    res.status(500).json({ error: 'Failed to load monetization' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /subscriptions — ?mode=active|trends|channel|churn  ?days= ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/subscriptions', async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['active', 'trends', 'channel', 'churn'], 'active');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    if (mode === 'active') {
      const [total, byStatus, active, rows] = await Promise.all([
        prisma.live_subscription.count(),
        prisma.live_subscription.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.live_subscription.count({ where: { status: 'active' } }),
        prisma.live_subscription.findMany({
          where: { status: 'active' }, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { subscription_id: true, subscriber_user_id: true, status: true, price_cents: true, currency: true,
            current_period_end: true, cancel_at_period_end: true, created_at: true,
            streamer: { select: { handle: true, display_name: true } } },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.subscriber_user_id));
      return res.json({
        mode, total, active, byStatus: mapGroup(byStatus, 'status'),
        pagination: { page, limit, pages: Math.ceil(active / limit) },
        subscriptions: rows.map((s) => ({ id: s.subscription_id, status: s.status, price: num(s.price_cents) / 100,
          currency: s.currency, current_period_end: s.current_period_end, cancel_at_period_end: s.cancel_at_period_end,
          created_at: s.created_at, streamer: s.streamer ? { handle: s.streamer.handle, display_name: s.streamer.display_name } : null,
          subscriber: users[s.subscriber_user_id] || { user_id: s.subscriber_user_id } })),
        note: 'Active subscriptions = live_subscription rows in active status (the $/mo creator subs).',
      });
    }

    if (mode === 'trends') {
      const [active, mrrAgg] = await Promise.all([
        prisma.live_subscription.count({ where: { status: 'active' } }),
        prisma.live_subscription.aggregate({ _sum: { price_cents: true }, where: { status: 'active' } }),
      ]);
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM live_subscription WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      const revDaily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, SUM(amount_cents)::float / 100 AS total
        FROM live_subscription_payment WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days,
        totals: { activeSubscriptions: active, mrr: num(mrrAgg._sum.price_cents) / 100 },
        newSubsDaily: daily.map((d) => ({ day: d.day, subs: num(d.n) })),
        revenueDaily: revDaily.map((d) => ({ day: d.day, total: num(d.total) })),
        note: 'MRR & trends = active-subscription MRR (sum of active price_cents), new-subs-per-day and subscription-revenue-per-day.',
      });
    }

    if (mode === 'channel') {
      const [total, topRaw] = await Promise.all([
        prisma.subscription.count(),
        prisma.subscription.groupBy({ by: ['channel_id'], _count: { _all: true }, orderBy: { _count: { channel_id: 'desc' } }, take: 15 }),
      ]);
      const channels = await prisma.channel.findMany({ where: { channel_id: { in: topRaw.map((t) => t.channel_id) } }, select: { channel_id: true, handle: true, display_name: true } });
      const cMap = Object.fromEntries(channels.map((c) => [c.channel_id, c]));
      const daily = await prisma.$queryRaw`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM subscription WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days, totals: { subscriptions: total },
        topChannels: topRaw.map((t) => ({ channel_id: t.channel_id, handle: cMap[t.channel_id]?.handle || null,
          display_name: cMap[t.channel_id]?.display_name || `Channel #${t.channel_id}`, subscribers: num(t._count._all) })),
        daily: daily.map((d) => ({ day: d.day, subs: num(d.n) })),
        note: 'Channel subscribers = the free video-channel follow (subscription) graph: total, most-subscribed channels, daily new subscribers.',
      });
    }

    // churn
    const [total, active, cancelScheduled, canceled] = await Promise.all([
      prisma.live_subscription.count(),
      prisma.live_subscription.count({ where: { status: 'active' } }),
      prisma.live_subscription.count({ where: { cancel_at_period_end: true } }),
      prisma.live_subscription.count({ where: { status: { in: ['canceled', 'cancelled', 'incomplete_expired', 'unpaid'] } } }),
    ]);
    return res.json({
      mode,
      totals: { total, active, cancelScheduled, canceled,
        churnRate: total > 0 ? +(((canceled + cancelScheduled) / total) * 100).toFixed(1) : 0 },
      note: 'Churn = live_subscription cancellations: cancel-at-period-end (scheduled) + canceled/expired/unpaid statuses, as a share of all subscriptions.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /subscriptions failed:', err);
    res.status(500).json({ error: 'Failed to load subscriptions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /safety — ?mode=shadowbanned|banned|nsfw|scores  ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/safety', async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['shadowbanned', 'banned', 'nsfw', 'scores'], 'shadowbanned');
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    if (mode === 'shadowbanned' || mode === 'banned') {
      const flag = mode === 'shadowbanned' ? { is_shadow_banned: true } : { is_banned: true };
      const [total, rows] = await Promise.all([
        prisma.social_profile.count({ where: flag }),
        prisma.social_profile.findMany({
          where: flag, orderBy: { updated_at: 'desc' }, skip, take: limit,
          select: { profile_id: true, user_id: true, handle: true, display_name: true,
            is_shadow_banned: true, is_banned: true, is_verified: true, updated_at: true, created_at: true },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        mode, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
        profiles: rows.map((p) => ({ profile_id: p.profile_id, handle: p.handle, display_name: p.display_name,
          is_shadow_banned: p.is_shadow_banned, is_banned: p.is_banned, is_verified: p.is_verified,
          updated_at: p.updated_at, created_at: p.created_at, owner: users[p.user_id] || { user_id: p.user_id } })),
        note: mode === 'shadowbanned' ? 'Shadow-banned = social profiles flagged is_shadow_banned. READ-ONLY (ban / unban is a write in the social admin route).'
          : 'Banned creators = social profiles flagged is_banned. READ-ONLY (ban / unban is a write in the social admin route).',
      });
    }

    if (mode === 'nsfw') {
      const [nsfwVideos, nsfwStreamers, sensitiveVideos, sensitiveFeed, rows] = await Promise.all([
        prisma.video.count({ where: { is_nsfw: true } }),
        prisma.live_streamer_profile.count({ where: { is_nsfw: true } }),
        prisma.video.count({ where: { is_sensitive: true } }),
        prisma.social_feed.count({ where: { is_sensitive: true } }),
        prisma.video.findMany({
          where: { is_nsfw: true }, orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { video_id: true, title: true, status: true, safety_score: true, views_count: true, created_at: true,
            channel: { select: { handle: true, display_name: true } } },
        }),
      ]);
      return res.json({
        mode, totals: { nsfwVideos, nsfwStreamers, sensitiveVideos, sensitiveFeed },
        pagination: { page, limit, pages: Math.ceil(nsfwVideos / limit) },
        videos: rows.map((v) => ({ id: v.video_id, title: v.title, status: v.status, safety_score: v.safety_score,
          views: v.views_count, created_at: v.created_at,
          channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null })),
        note: 'NSFW flags = videos / streamers marked is_nsfw plus is_sensitive content. READ-ONLY audit view.',
      });
    }

    // scores — low safety-score videos
    const [flagged, rows] = await Promise.all([
      prisma.video.count({ where: { safety_score: { lt: 0.5 } } }),
      prisma.video.findMany({
        where: { safety_score: { lt: 0.5 } }, orderBy: { safety_score: 'asc' }, skip, take: limit,
        select: { video_id: true, title: true, status: true, safety_score: true, safety_status: true,
          moderation_flag: true, is_nsfw: true, created_at: true, channel: { select: { handle: true, display_name: true } } },
      }),
    ]);
    return res.json({
      mode, totals: { lowScoreVideos: flagged },
      pagination: { page, limit, pages: Math.ceil(flagged / limit) },
      videos: rows.map((v) => ({ id: v.video_id, title: v.title, status: v.status, safety_score: v.safety_score,
        safety_status: v.safety_status, moderation_flag: v.moderation_flag, is_nsfw: v.is_nsfw, created_at: v.created_at,
        channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null })),
      note: 'Safety scores = videos with a low automated safety_score (< 0.5), lowest first, with the moderation flag / status. READ-ONLY.',
    });
  } catch (err) {
    console.error('[board-admin/creator-ops] /safety failed:', err);
    res.status(500).json({ error: 'Failed to load safety' });
  }
});

export default router;
