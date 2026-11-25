import express from 'express';
import multer from 'multer';
import xss from 'xss';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { uploadVideoStream } from '../utils/azure-storage.js';
import { checkHandleAvailability } from '../utils/handle-availability.js';
import { validateChannelInput } from '../utils/channel-input.js';
import { creatorVisibility } from '../utils/video-visibility.js';
import { buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { notify } from '../services/notify.js';
import {
  creatorAnalyticsBucketKey,
  normalizeCreatorAnalyticsRange,
  resolveCreatorAnalyticsRange,
} from '../utils/creator-analytics-ranges.js';
import {
  EMPTY_CREATOR_AUDIENCE_INTELLIGENCE,
  shapeCreatorAudienceIntelligence,
} from '../utils/creator-audience-intelligence.js';
import {
  MAX_CREATOR_PICKS,
  CREATOR_PICK_VIDEO_SELECT,
  CREATOR_PICK_CHANNEL_SELECT,
  RECOMMENDER_SELECT,
  parseSubscriberPicksQuery,
  parseCreatePickBody,
  parsePickIdParam,
  ownedCreatorPickOr404,
  dedupeSubscriberPicks,
  filterSubscriberPickRows,
  capSubscriberPicks,
  toCreatorPickCard,
  toCreatorManagePick,
} from '../utils/creator-choice-picks.js';

const router = express.Router();

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } 
});

const RANGE_DAYS = { '7d': 7, '28d': 28, '90d': 90, '365d': 365, 'lifetime': 365 };

function resolveRange(days) {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  prevStart.setUTCHours(0, 0, 0, 0);
  return { start, prevStart, prevEnd };
}

function dayKey(d) { 
  return new Date(d).toISOString().slice(0, 10); 
}

function buildDateBuckets(start, days) {
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    buckets.push(dayKey(d));
  }
  return buckets;
}

function pctChange(curr, prev) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
}

async function loadCreatorAudienceIntelligence(channelId, start) {
  const [summaryRows, sourceRows] = await Promise.all([
    prisma.$queryRaw`
      WITH creator_videos AS (
        SELECT video_id, NULLIF(duration_sec, 0) AS duration_sec
        FROM video
        WHERE channel_id = ${channelId} AND status = 'safe'
      ), audience AS (
        SELECT wh.user_id, wh.last_position, wh.credited_sec, cv.duration_sec
        FROM watch_history wh
        JOIN creator_videos cv ON cv.video_id = wh.video_id
        WHERE wh.watched_at >= ${start}
      ), engaged AS (
        SELECT vl.user_id
        FROM video_likes vl JOIN creator_videos cv ON cv.video_id = vl.video_id
        WHERE vl.is_like = true AND vl.created_at >= ${start}
        UNION
        SELECT vc.user_id
        FROM video_comments vc JOIN creator_videos cv ON cv.video_id = vc.video_id
        WHERE vc.created_at >= ${start}
      ), viewer_impressions AS (
        SELECT ci.profile_id, SUM(ci.impressions)::int AS impressions
        FROM content_impression ci
        JOIN creator_videos cv ON cv.video_id = ci.content_id
        WHERE ci.content_type = 'video' AND ci.updated_at >= ${start}
        GROUP BY ci.profile_id
      ), impression_totals AS (
        SELECT COALESCE(SUM(impressions), 0)::int AS impressions,
               COUNT(*) FILTER (WHERE impressions > 1)::int AS returning_viewers,
               COUNT(*) FILTER (WHERE impressions <= 1)::int AS new_viewers
        FROM viewer_impressions
      )
      SELECT it.impressions,
             COUNT(a.user_id)::int AS starts,
             COUNT(a.user_id) FILTER (WHERE a.credited_sec >= 30)::int AS meaningful_watches,
             COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.9)::int AS completed,
             (SELECT COUNT(*)::int FROM engaged) AS engaged,
             it.returning_viewers,
             it.new_viewers,
             COUNT(a.user_id) FILTER (WHERE s.user_id IS NOT NULL)::int AS subscribers,
             COUNT(a.user_id) FILTER (WHERE s.user_id IS NULL)::int AS non_subscribers,
             ARRAY[
               100,
               COALESCE(ROUND(100.0 * COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.1) / NULLIF(COUNT(a.user_id), 0)), 0),
               COALESCE(ROUND(100.0 * COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.25) / NULLIF(COUNT(a.user_id), 0)), 0),
               COALESCE(ROUND(100.0 * COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.5) / NULLIF(COUNT(a.user_id), 0)), 0),
               COALESCE(ROUND(100.0 * COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.75) / NULLIF(COUNT(a.user_id), 0)), 0),
               COALESCE(ROUND(100.0 * COUNT(a.user_id) FILTER (WHERE a.duration_sec IS NOT NULL AND a.last_position >= a.duration_sec * 0.9) / NULLIF(COUNT(a.user_id), 0)), 0)
             ]::int[] AS retention
      FROM impression_totals it
      LEFT JOIN audience a ON true
      LEFT JOIN subscription s ON s.channel_id = ${channelId} AND s.user_id = a.user_id
      GROUP BY it.impressions, it.returning_viewers, it.new_viewers
    `,
    prisma.$queryRaw`
      SELECT COALESCE(NULLIF(ci.source, ''), 'Unknown') AS label,
             COALESCE(SUM(ci.impressions), 0)::int AS value
      FROM content_impression ci
      JOIN video v ON v.video_id = ci.content_id
      WHERE ci.content_type = 'video'
        AND v.channel_id = ${channelId}
        AND v.status = 'safe'
        AND ci.updated_at >= ${start}
      GROUP BY 1
      ORDER BY value DESC
      LIMIT 8
    `,
  ]);

  return shapeCreatorAudienceIntelligence(summaryRows[0], sourceRows);
}

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const input = validateChannelInput(req.body);
    if (input.error) return res.status(400).json({ successful: false, code: 'INVALID_CHANNEL_INPUT', message: input.error, field: input.field });
    const { handle: normalizedHandle, display_name, description } = input.data;
    const user_id = req.user.user_id;

    const existingChannel = await prisma.channel.findUnique({ where: { user_id } });
    if (existingChannel) {
      return res.status(400).json({ successful: false, code: 'CHANNEL_EXISTS', message: "You already have a channel." });
    }

    const availability = await checkHandleAvailability(normalizedHandle, user_id);
    if (!availability.available) {
      return res.status(400).json({ successful: false, message: "Handle is already taken." });
    }

    const newChannel = await prisma.channel.create({
      data: {
        user_id,
        handle: normalizedHandle,
        display_name,
        description
      }
    });

    res.status(201).json({ successful: true, message: "Channel created!", channel: newChannel });
  } catch (err) {
    if (err.code === 'P2002') {
      // The unique user_id constraint can win a concurrent registration race too.
      // Do not mislabel it as an unrelated handle collision.
      try {
        const existing = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
        if (existing) return res.status(400).json({ successful: false, code: 'CHANNEL_EXISTS', message: 'You already have a channel.' });
      } catch (lookupError) { return next(lookupError); }
      return res.status(400).json({ successful: false, message: "Handle is already taken." });
    }
    next(err);
  }
});

router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const channel = await prisma.channel.findUnique({
      where: { user_id: req.user.user_id },
      include: { _count: { select: { videos: true, subscriptions: true } } }
    });
    if (!channel) {
      return res.status(404).json({ successful: false, message: "No channel found." });
    }
    res.json({ successful: true, data: channel });
  } catch (err) { 
    next(err); 
  }
});

router.get('/profile/:handle', async (req, res, next) => {
  try {
    const { handle } = req.params;
    const channel = await prisma.channel.findUnique({
      where: { handle: handle.toLowerCase() },
      include: {
        _count: { select: { videos: { where: { status: 'safe' } }, subscriptions: true } },
        user: { select: { name: true } }
      }
    });
    if (!channel || !channel.is_active) {
      return res.status(404).json({ successful: false, message: "Channel not found." });
    }
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json({ successful: true, data: channel });
  } catch (err) { 
    next(err); 
  }
});

router.patch('/active', authenticateToken, async (req, res, next) => {
  try {
    if (typeof req.body?.is_active !== 'boolean') {
      return res.status(400).json({ successful: false, message: "is_active (boolean) is required." });
    }
    const updated = await prisma.channel.update({
      where: { user_id: req.user.user_id },
      data: { is_active: req.body.is_active, updated_at: new Date() }
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ successful: false, message: "No channel found. Create a channel first." });
    }
    next(err);
  }
});

router.put('/update', authenticateToken, async (req, res, next) => {
  try {
    const input = validateChannelInput(req.body, { partial: true });
    if (input.error) return res.status(400).json({ successful: false, code: 'INVALID_CHANNEL_INPUT', message: input.error, field: input.field });
    const { handle: normalizedHandle } = input.data;
    if (normalizedHandle) {
      const availability = await checkHandleAvailability(normalizedHandle, req.user.user_id);
      if (!availability.available) {
        return res.status(400).json({ successful: false, message: "Handle is already taken." });
      }
    }
    const updated = await prisma.channel.update({
      where: { user_id: req.user.user_id },
      data: {
        ...input.data,
        updated_at: new Date()
      }
    });
    res.json({ successful: true, message: "Profile updated!", data: updated });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ successful: false, message: "No channel found. Create a channel first." });
    }
    if (err.code === 'P2002') {
      return res.status(400).json({ successful: false, message: "Handle is already taken." });
    }
    next(err);
  }
});

router.post('/branding/upload', authenticateToken, upload.single('image'), async (req, res, next) => {
  try {
    const { type } = req.body;
    const user_id = req.user.user_id;

    if (!req.file || !['avatar', 'banner'].includes(type)) {
      return res.status(400).json({ successful: false, message: "Valid image and type required." });
    }

    const fileExtension = req.file.originalname.split('.').pop();
    const blobName = `branding/${type}-${user_id}-${Date.now()}.${fileExtension}`;
    
    const imageUrl = await uploadVideoStream(
      process.env.AZURE_THUMBNAIL_CONTAINER,
      blobName,
      req.file.buffer,
      req.file.mimetype,
      { access: 'blob' }
    );

    const updateData = type === 'avatar' ? { profile_pic_url: imageUrl } : { banner_url: imageUrl };
    const updated = await prisma.channel.update({
      where: { user_id },
      data: updateData
    });

    res.json({ successful: true, message: `${type} updated!`, url: imageUrl, data: updated });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ successful: false, message: "No channel found. Create a channel first." });
    }
    next(err);
  }
});

router.get('/monetization-status', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: { 
        _count: { select: { subscriptions: true } }, 
        videos: { 
          where: { status: 'safe' },
          select: { video_id: true } 
        } 
      }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: "Channel not found." });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    
    const oneYearAgo = new Date();
    oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);

    const watchData = videoIds.length > 0 
      ? await prisma.video_analytics.aggregate({
          where: { 
            video_id: { in: videoIds },
            created_at: { gte: oneYearAgo }
          },
          _sum: { watch_time_sec: true }
        })
      : { _sum: { watch_time_sec: 0 } };

    const watchHours = (watchData._sum.watch_time_sec || 0) / 3600;
    const subCount = channel._count.subscriptions;
    const isEligible = subCount >= 1000 && watchHours >= 3000;

    res.json({
      successful: true,
      data: {
        current_subs: subCount,
        required_subs: 1000,
        current_watch_hours: parseFloat(watchHours.toFixed(2)),
        required_watch_hours: 3000,
        is_eligible: isEligible,
        is_verified: channel.is_verified,
        progress_percentage: parseFloat(Math.min(((watchHours / 3000) * 100), 100).toFixed(1))
      }
    });
  } catch (err) { 
    next(err); 
  }
});

router.post('/request-verification', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: { 
        _count: { select: { subscriptions: true } }, 
        videos: { 
          where: { status: 'safe' },
          select: { video_id: true } 
        } 
      }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: "Channel not found." });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    
    const oneYearAgo = new Date();
    oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);

    const watchData = videoIds.length > 0 
      ? await prisma.video_analytics.aggregate({
          where: { 
            video_id: { in: videoIds },
            created_at: { gte: oneYearAgo }
          },
          _sum: { watch_time_sec: true }
        })
      : { _sum: { watch_time_sec: 0 } };

    const watchHours = (watchData._sum.watch_time_sec || 0) / 3600;

    if (channel._count.subscriptions >= 1000 && watchHours >= 3000) {
      await prisma.board_task.create({
        data: {
          title: `Channel Verification Review: @${channel.handle}`,
          description: `Creator ${req.user.name} has requested channel verification. Subs: ${channel._count.subscriptions}, 365d Watch Hours: ${watchHours.toFixed(2)}`,
          status: 'backlog',
          priority: 'medium',
          vertical: 'verification',
          assigner_id: 1,
          source_type: 'channel_verification',
          source_id: channel.channel_id
        }
      });

      res.json({ successful: true, message: "Verification request submitted to Admin!" });
    } else {
      res.status(400).json({ successful: false, message: "Milestones not met yet." });
    }
  } catch (err) { 
    next(err); 
  }
});

router.get('/me/analytics', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const cacheKey = `channel:analytics:${user_id}`;

    let cachedData = null;
    try {
      cachedData = await redis.get(cacheKey);
    } catch (_) {}

    if (cachedData) {
      return res.json({ successful: true, source: 'cache', data: JSON.parse(cachedData) });
    }

    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: {
        videos: {
          where: { status: { not: 'banned' } },
          select: {
            video_id: true, 
            title: true, 
            views_count: true, 
            created_at: true,
            _count: { select: { video_likes: true, video_comments: true } },
          },
          orderBy: { views_count: 'desc' },
        },
        _count: { select: { subscriptions: true, videos: true } }
      }
    });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const videoIds = channel.videos.map(v => v.video_id);

    const [watchData, total_likes, total_comments] = await Promise.all([
      videoIds.length > 0
        ? prisma.video_analytics.aggregate({
            where: { video_id: { in: videoIds } },
            _sum: { watch_time_sec: true },
          })
        : Promise.resolve({ _sum: { watch_time_sec: 0 } }),
      videoIds.length > 0
        ? prisma.video_likes.count({ where: { video_id: { in: videoIds } } })
        : Promise.resolve(0),
      videoIds.length > 0
        ? prisma.video_comments.count({ where: { video_id: { in: videoIds } } })
        : Promise.resolve(0),
    ]);

    const total_views = channel.videos.reduce((s, v) => s + (v.views_count || 0), 0);
    const video_count = channel._count.videos;
    const avg_views = video_count > 0 ? Math.round(total_views / video_count) : 0;
    
    const engagement_rate = total_views > 0
      ? parseFloat(Math.min(((total_likes + total_comments) / total_views) * 100, 100).toFixed(2))
      : 0.0;

    res.json({
      successful: true,
      data: {
        channel_id: channel.channel_id,
        subscriber_count: channel._count.subscriptions,
        video_count,
        total_views,
        avg_views,
        engagement_rate,
        watch_time_hours: parseFloat(((watchData._sum.watch_time_sec || 0) / 3600).toFixed(1)),
        top_videos: channel.videos.slice(0, 5).map(v => ({
          video_id: v.video_id,
          title: v.title,
          views: v.views_count,
          views_count: v.views_count,
          likes: v._count.video_likes,
          comments: v._count.video_comments,
        })),
      },
    });
  } catch (err) { 
    next(err); 
  }
});

router.get('/me/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const rangeParam = normalizeCreatorAnalyticsRange(req.query.range);

    // Analytics aggregation is expensive (8 parallel range queries + bucketing). Serve from a
    // 5-minute Redis cache keyed by user + range to cut PostgreSQL load. Cache-aside: a Redis
    // outage just falls through to a live computation (redis fails open).
    const analyticsCacheKey = `channel:analytics:overview:${user_id}:${rangeParam}`;
    try {
      const cached = await redis.get(analyticsCacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* fall through to live compute */ }

    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: {
        videos: {
          where: { status: 'safe' },
          select: { video_id: true, title: true, category: true, thumbnail_url: true, duration_sec: true, created_at: true, views_count: true },
        },
        _count: { select: { subscriptions: true } },
      },
    });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    const earliestVideoDate = channel.videos.reduce((earliest, video) => {
      if (!video.created_at) return earliest;
      return !earliest || video.created_at < earliest ? video.created_at : earliest;
    }, channel.created_at || null);
    const rangeConfig = resolveCreatorAnalyticsRange(rangeParam, earliestVideoDate);
    const { start, end, previousStart: prevStart, previousEnd: prevEnd, buckets, granularity } = rangeConfig;
    const isLifetime = rangeParam === 'all';
    const bucketIndex = new Map(buckets.map((d, i) => [d, i]));
    const currentCreatedAt = start ? { gte: start, lte: end } : { lte: end };
    const previousCreatedAt = prevStart ? { gte: prevStart, lte: prevEnd } : undefined;

    if (videoIds.length === 0) {
      return res.json({
        successful: true,
        data: {
          range: rangeParam,
          granularity,
          summary: { total_views: 0, views_change_pct: null, total_subscribers: channel._count.subscriptions, net_subscribers: 0, subscribers_change_pct: null, total_likes: 0, total_comments: 0, engagement_rate: 0, engagement_change_pct: null, watch_time_minutes: 0, has_watch_time_data: false, avg_view_percentage: null },
          timeseries: buckets.map(date => ({ date, views: 0, likes: 0, comments: 0, subscribers_net: 0 })),
          top_videos: [],
          category_breakdown: [],
          geography: [],
          devices: [],
          audience_intelligence: EMPTY_CREATOR_AUDIENCE_INTELLIGENCE,
        },
      });
    }

    const [analyticsRows, prevAnalyticsRows, likeRows, prevLikeRows, commentRows, prevCommentRows, subRows, prevSubRows] = await Promise.all([
      prisma.video_analytics.findMany({ where: { video_id: { in: videoIds }, created_at: currentCreatedAt }, select: { video_id: true, watch_time_sec: true, viewer_country: true, device_type: true, created_at: true } }),
      previousCreatedAt ? prisma.video_analytics.findMany({ where: { video_id: { in: videoIds }, created_at: previousCreatedAt }, select: { watch_time_sec: true } }) : Promise.resolve([]),
      prisma.video_likes.findMany({ where: { video_id: { in: videoIds }, is_like: true, created_at: currentCreatedAt }, select: { video_id: true, created_at: true } }),
      previousCreatedAt ? prisma.video_likes.findMany({ where: { video_id: { in: videoIds }, is_like: true, created_at: previousCreatedAt }, select: { video_id: true } }) : Promise.resolve([]),
      prisma.video_comments.findMany({ where: { video_id: { in: videoIds }, created_at: currentCreatedAt }, select: { video_id: true, created_at: true } }),
      previousCreatedAt ? prisma.video_comments.findMany({ where: { video_id: { in: videoIds }, created_at: previousCreatedAt }, select: { video_id: true } }) : Promise.resolve([]),
      prisma.subscription.findMany({ where: { channel_id: channel.channel_id, created_at: currentCreatedAt }, select: { created_at: true } }),
      previousCreatedAt ? prisma.subscription.findMany({ where: { channel_id: channel.channel_id, created_at: previousCreatedAt }, select: { created_at: true } }) : Promise.resolve([]),
    ]);

    const tsViews = new Array(buckets.length).fill(0);
    const tsLikes = new Array(buckets.length).fill(0);
    const tsComments = new Array(buckets.length).fill(0);
    const tsSubs = new Array(buckets.length).fill(0);

    analyticsRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(creatorAnalyticsBucketKey(r.created_at, granularity)); if (i != null) tsViews[i] += 1; });
    likeRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(creatorAnalyticsBucketKey(r.created_at, granularity)); if (i != null) tsLikes[i] += 1; });
    commentRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(creatorAnalyticsBucketKey(r.created_at, granularity)); if (i != null) tsComments[i] += 1; });
    subRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(creatorAnalyticsBucketKey(r.created_at, granularity)); if (i != null) tsSubs[i] += 1; });

    const timeseries = buckets.map((date, i) => ({ date, views: tsViews[i], likes: tsLikes[i], comments: tsComments[i], subscribers_net: tsSubs[i] }));

    const rangeViews = analyticsRows.length;
    const rangeLikes = likeRows.length;
    const rangeComments = commentRows.length;
    const rangeWatchSec = analyticsRows.reduce((s, r) => s + (r.watch_time_sec || 0), 0);
    const rangeNetSubs = subRows.length;

    const total_views = isLifetime ? channel.videos.reduce((s, v) => s + (v.views_count || 0), 0) : rangeViews;
    const has_watch_time_data = analyticsRows.length > 0;

    const prevViews = prevAnalyticsRows.length;
    const prevLikes = prevLikeRows.length;
    const prevComments = prevCommentRows.length;
    const prevSubs = prevSubRows.length;

    const engagement_rate = total_views > 0 ? parseFloat(((rangeLikes + rangeComments) / total_views).toFixed(3)) : 0;
    const prevEngagementRate = prevViews > 0 ? (prevLikes + prevComments) / prevViews : 0;

    const aByVid = new Map();
    for (const r of analyticsRows) {
      const e = aByVid.get(r.video_id) || { count: 0, watchSum: 0 };
      e.count += 1; e.watchSum += (r.watch_time_sec || 0);
      aByVid.set(r.video_id, e);
    }
    const likesByVid = new Map();
    for (const r of likeRows) likesByVid.set(r.video_id, (likesByVid.get(r.video_id) || 0) + 1);
    const commentsByVid = new Map();
    for (const r of commentRows) commentsByVid.set(r.video_id, (commentsByVid.get(r.video_id) || 0) + 1);

    const top_videos = channel.videos
      .map(v => {
        const a = aByVid.get(v.video_id) || { count: 0, watchSum: 0 };
        const avgWatch = a.count ? Math.round(a.watchSum / a.count) : null;
        return {
          video_id: v.video_id, title: v.title, thumbnail_url: v.thumbnail_url,
          views_count: isLifetime ? v.views_count : a.count,
          likes_count: likesByVid.get(v.video_id) || 0,
          comments_count: commentsByVid.get(v.video_id) || 0,
          avg_view_duration_sec: avgWatch, duration_sec: v.duration_sec, published_at: v.created_at,
        };
      })
      .sort((a, b) => b.views_count - a.views_count)
      .slice(0, 10);

    const categoryMap = new Map();
    channel.videos.forEach(v => {
      const cat = v.category || 'General';
      const viewsForVid = isLifetime ? (v.views_count || 0) : (aByVid.get(v.video_id)?.count || 0);
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + viewsForVid);
    });
    const category_breakdown = [...categoryMap.entries()].map(([category, views]) => ({ category, views })).sort((a, b) => b.views - a.views);

    // #272/#146: audience geography + device breakdown + avg view %. viewer_country /
    // device_type / duration all already live on the fetched rows, so this is pure
    // in-memory aggregation (no extra queries). Top 8 countries; the rest roll into "Other".
    const durationByVid = new Map(channel.videos.map(v => [v.video_id, v.duration_sec || 0]));
    const countryMap = new Map();
    const deviceMap = new Map();
    let viewPctSum = 0, viewPctCount = 0;
    for (const r of analyticsRows) {
      const c = r.viewer_country || 'Unknown';
      countryMap.set(c, (countryMap.get(c) || 0) + 1);
      const dev = r.device_type || 'Unknown';
      deviceMap.set(dev, (deviceMap.get(dev) || 0) + 1);
      const dur = durationByVid.get(r.video_id) || 0;
      if (dur > 0) { viewPctSum += Math.min(100, ((r.watch_time_sec || 0) / dur) * 100); viewPctCount += 1; }
    }
    const geoSorted = [...countryMap.entries()].map(([country, views]) => ({ country, views })).sort((a, b) => b.views - a.views);
    const geography = geoSorted.slice(0, 8);
    if (geoSorted.length > 8) geography.push({ country: 'Other', views: geoSorted.slice(8).reduce((s, g) => s + g.views, 0) });
    const devices = [...deviceMap.entries()].map(([device, views]) => ({ device, views })).sort((a, b) => b.views - a.views);
    const avg_view_percentage = viewPctCount > 0 ? parseFloat((viewPctSum / viewPctCount).toFixed(1)) : null;
    const audience_intelligence = await loadCreatorAudienceIntelligence(channel.channel_id, start);

    const overviewPayload = {
      successful: true,
      data: {
        range: rangeParam,
        granularity,
        summary: {
          total_views,
          views_change_pct: isLifetime ? null : pctChange(rangeViews, prevViews),
          total_subscribers: channel._count.subscriptions,
          net_subscribers: rangeNetSubs,
          subscribers_change_pct: isLifetime ? null : pctChange(rangeNetSubs, prevSubs),
          total_likes: rangeLikes,
          total_comments: rangeComments,
          engagement_rate,
          engagement_change_pct: isLifetime ? null : pctChange(engagement_rate, prevEngagementRate),
          watch_time_minutes: parseFloat((rangeWatchSec / 60).toFixed(1)),
          has_watch_time_data,
          avg_view_percentage,
        },
        timeseries,
        top_videos,
        category_breakdown,
        geography,
        devices,
        audience_intelligence,
      },
    };
    Promise.resolve(redis.set(analyticsCacheKey, JSON.stringify(overviewPayload), 'EX', rangeParam === '24h' ? 60 : 300)).catch(() => {});
    res.json(overviewPayload);
  } catch (err) {
    next(err);
  }
});

router.get('/me/analytics/videos/:videoId', authenticateToken, async (req, res, next) => {
  try {
    const video_id = Number(req.params.videoId);
    if (Number.isNaN(video_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid video id.' });
    }

    const video = await prisma.video.findFirst({
      where: { video_id, channel: { user_id: req.user.user_id } },
      select: { video_id: true, title: true, thumbnail_url: true, duration_sec: true, created_at: true },
    });
    if (!video) {
      return res.status(404).json({ successful: false, message: 'Video not found on your channel.' });
    }

    const rangeParam = normalizeCreatorAnalyticsRange(req.query.range);
    const { start, end, buckets, granularity } = resolveCreatorAnalyticsRange(rangeParam, video.created_at);
    const currentCreatedAt = start ? { gte: start, lte: end } : { lte: end };

    const [analyticsRows, likeCount, commentCount] = await Promise.all([
      prisma.video_analytics.findMany({ where: { video_id, created_at: currentCreatedAt }, select: { watch_time_sec: true, created_at: true, viewer_country: true, device_type: true } }),
      prisma.video_likes.count({ where: { video_id, is_like: true, created_at: currentCreatedAt } }),
      prisma.video_comments.count({ where: { video_id, created_at: currentCreatedAt } }),
    ]);

    const bucketIndex = new Map(buckets.map((d, i) => [d, i]));
    const tsViews = new Array(buckets.length).fill(0);
    const tsWatch = new Array(buckets.length).fill(0);
    // Audience geography + device mix (#146) — both columns are now populated on each watch
    // ping (see video-engagement viewerSignals). Rows predating that change carry nulls, which
    // we surface as an "Unknown" bucket so the totals still reconcile with the view count.
    const geoCounts = new Map();
    const deviceCounts = new Map();
    analyticsRows.forEach(r => {
      if (r.created_at) { const i = bucketIndex.get(creatorAnalyticsBucketKey(r.created_at, granularity)); if (i != null) { tsViews[i] += 1; tsWatch[i] += (r.watch_time_sec || 0); } }
      const cc = r.viewer_country || 'Unknown';
      geoCounts.set(cc, (geoCounts.get(cc) || 0) + 1);
      const dev = r.device_type || 'unknown';
      deviceCounts.set(dev, (deviceCounts.get(dev) || 0) + 1);
    });
    const timeseries = buckets.map((date, i) => ({ date, views: tsViews[i], watch_time_sec: tsWatch[i], likes: 0, comments: 0 }));

    const views = analyticsRows.length;
    const totalWatchSec = analyticsRows.reduce((s, r) => s + (r.watch_time_sec || 0), 0);
    const avgWatchSec = views ? totalWatchSec / views : 0;
    const retention_pct = video.duration_sec ? Math.min(100, parseFloat(((avgWatchSec / video.duration_sec) * 100).toFixed(1))) : null;

    const geography = [...geoCounts.entries()]
      .map(([country, v]) => ({ country, views: v, pct: views ? parseFloat(((v / views) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);
    const devices = [...deviceCounts.entries()]
      .map(([device, v]) => ({ device, views: v, pct: views ? parseFloat(((v / views) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.views - a.views);
    const hasGeoData = geography.some(g => g.country !== 'Unknown');
    const hasDeviceData = devices.some(d => d.device !== 'unknown');

    res.json({
      successful: true,
      data: {
        range: rangeParam, granularity,
        video_id: video.video_id, title: video.title, thumbnail_url: video.thumbnail_url,
        duration_sec: video.duration_sec, published_at: video.created_at,
        summary: {
          views, likes: likeCount, comments: commentCount, retention_pct,
          total_watch_time_sec: totalWatchSec, avg_watch_sec: Math.round(avgWatchSec),
          has_watch_time_data: views > 0,
        },
        timeseries,
        geography, devices,
        has_geo_data: hasGeoData, has_device_data: hasDeviceData,
        retention_curve: null,
      },
    });
  } catch (err) { 
    next(err); 
  }
});

router.get('/me/earnings/overview', authenticateToken, async (req, res, next) => {
  try {
    const rangeParam = RANGE_DAYS[req.query.range] ? req.query.range : '28d';
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    // 5-minute Redis cache (cache-aside; fails open) — earnings rolls up several revenue
    // tables per range, so repeated dashboard loads shouldn't re-query PostgreSQL each time.
    const earningsCacheKey = `channel:earnings:overview:${req.user.user_id}:${rangeParam}`;
    try {
      const cached = await redis.get(earningsCacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* fall through to live compute */ }

    const channel = await prisma.channel.findUnique({
      where: { user_id: req.user.user_id },
      include: { videos: { select: { video_id: true, title: true, thumbnail_url: true } } },
    });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    const num = d => (d == null ? 0 : Number(d));
    const grossOf = r => num(r.total_earned);
    const netOf = r => num(r.creator_share);

    const baseEmpty = buildEarningsSeries({ rows: [], dateField: 'created_at', gross: grossOf, net: netOf, start, days });
    if (videoIds.length === 0) {
      return res.json({
        successful: true,
        data: {
          range: rangeParam,
          currency: 'CAD',
          lifetime_net: 0,
          summary: baseEmpty.summary,
          timeseries: baseEmpty.timeseries,
          breakdown: [
            { source: 'Ad Revenue', value: 0 },
            { source: 'Subscriptions', value: 0 },
            { source: 'Tips & Donations', value: 0 }
          ],
          top: []
        }
      });
    }

    const [adRevenueRows, prevAdRevenueRows, lifetimeAdAgg, liveSubPayments, donations] = await Promise.all([
      prisma.revenue_share_log.findMany({ 
        where: { video_id: { in: videoIds }, created_at: { gte: start } }, 
        select: { video_id: true, total_earned: true, creator_share: true, created_at: true } 
      }),
      prisma.revenue_share_log.findMany({ 
        where: { video_id: { in: videoIds }, created_at: { gte: prevStart, lte: prevEnd } }, 
        select: { total_earned: true, creator_share: true } 
      }),
      prisma.revenue_share_log.aggregate({ 
        where: { video_id: { in: videoIds } }, 
        _sum: { creator_share: true } 
      }),
      prisma.live_subscription_payment.findMany({
        where: { streamer_id: channel.channel_id, created_at: { gte: start } },
        select: { creator_share: true }
      }),
      prisma.donations.findMany({
        where: { projects: { owner_user_id: channel.user_id }, donated_date: { gte: start } },
        select: { amount: true }
      })
    ]);

    const { timeseries, summary } = buildEarningsSeries({ rows: adRevenueRows, prevRows: prevAdRevenueRows, dateField: 'created_at', gross: grossOf, net: netOf, start, days });

    const totalAdRevenue = adRevenueRows.reduce((s, r) => s + netOf(r), 0);
    const totalSubscriptionRevenue = liveSubPayments.reduce((s, p) => s + num(p.creator_share), 0);
    const totalDonations = donations.reduce((s, d) => s + num(d.amount), 0);

    const breakdown = [
      { source: 'Ad Revenue', value: round2(totalAdRevenue) },
      { source: 'Subscriptions', value: round2(totalSubscriptionRevenue) },
      { source: 'Tips & Donations', value: round2(totalDonations) }
    ];

    const titleById = new Map(channel.videos.map(v => [v.video_id, v]));
    const byVid = new Map();
    for (const r of adRevenueRows) {
      const e = byVid.get(r.video_id) || { id: r.video_id, gross: 0, net: 0 };
      e.gross += grossOf(r); e.net += netOf(r);
      byVid.set(r.video_id, e);
    }
    const top = [...byVid.values()]
      .map(e => { 
        const v = titleById.get(e.id); 
        return { id: e.id, title: v?.title || 'Video', thumbnail_url: v?.thumbnail_url || null, subtitle: 'Ad + subs', gross: round2(e.gross), net: round2(e.net), count: 0 }; 
      })
      .sort((a, b) => b.net - a.net)
      .slice(0, 8);

    const earningsPayload = {
      successful: true,
      data: {
        range: rangeParam, currency: 'CAD',
        lifetime_net: round2(num(lifetimeAdAgg._sum.creator_share) + totalSubscriptionRevenue + totalDonations),
        summary,
        timeseries,
        breakdown,
        top,
      },
    };
    Promise.resolve(redis.set(earningsCacheKey, JSON.stringify(earningsPayload), 'EX', 300)).catch(() => {});
    res.json(earningsPayload);
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const subs = await prisma.subscription.findMany({
      where: { user_id },
      include: {
        channel: {
          include: { _count: { select: { subscriptions: true, videos: true } } },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    const data = subs.map(s => ({
      channel_id:       s.channel.channel_id,
      channel_name:     s.channel.display_name,
      handle:           s.channel.handle,
      profile_pic_url:  s.channel.profile_pic_url,
      banner_url:       s.channel.banner_url,
      subscriber_count: s.channel._count.subscriptions,
      video_count:      s.channel._count.videos,
      subscribed_at:    s.created_at,
    }));
    res.json({ successful: true, data });
  } catch (err) { 
    next(err); 
  }
});

/**
 * Latest uploads from channels the viewer subscribes to — watch-edge "Subs" drawer.
 * Newest first across every subscribed channel, cursor-paginated.
 * Query: ?limit=12&exclude=<video_id>&cursor=<opaque>
 */
router.get('/subscriptions/uploads', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const { visibleVideoWhere } = await import('../utils/video-visibility.js');
    const {
      parseSubscriptionUploadsQuery,
      isNewSubscriptionUpload,
      SUB_UPLOAD_CHANNEL_SCAN,
    } = await import('../utils/subscription-uploads.js');

    const { limit, excludeId } = parseSubscriptionUploadsQuery(req.query);
    const { decodeCursor, pageResult } = await import('../utils/video-pagination.js');
    let cursor = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor?.created_at || !Number.isFinite(new Date(cursor.created_at).getTime()) || !Number.isInteger(cursor?.video_id)) {
        return res.status(400).json({ successful: false, message: 'Invalid uploads cursor.' });
      }
    }

    const subs = await prisma.subscription.findMany({
      where: { user_id },
      select: { channel_id: true },
      orderBy: { created_at: 'desc' },
      take: SUB_UPLOAD_CHANNEL_SCAN,
    });
    const channelIds = [...new Set(subs.map((s) => s.channel_id).filter((id) => id != null))];
    if (!channelIds.length) {
      return res.json({ successful: true, data: [] });
    }

    const uploadSelect = {
      video_id: true,
      public_id: true,
      slug: true,
      title: true,
      thumbnail_url: true,
      duration_sec: true,
      views_count: true,
      video_type: true,
      category: true,
      created_at: true,
      channel_id: true,
      channel: {
        select: {
          channel_id: true,
          display_name: true,
          handle: true,
          profile_pic_url: true,
        },
      },
    };

    // Straight recency over the whole subscription pool: the drawer is a feed, so a channel that
    // posted twice today gets both rows rather than being rationed to one.
    const baseWhere = visibleVideoWhere({
        video_type: 'long',
        channel_id: { in: channelIds },
        ...(excludeId != null ? { video_id: { not: excludeId } } : {}),
      });
    const uploads = await prisma.video.findMany({
      where: cursor ? {
        AND: [
          baseWhere,
          {
            OR: [
              { created_at: { lt: new Date(cursor.created_at) } },
              { created_at: new Date(cursor.created_at), video_id: { lt: cursor.video_id } },
            ],
          },
        ],
      } : baseWhere,
      orderBy: [{ created_at: 'desc' }, { video_id: 'desc' }],
      take: limit + 1,
      select: uploadSelect,
    });


    const page = pageResult(uploads, limit, (v) => ({ created_at: v.created_at, video_id: v.video_id }));
    const data = page.data.map((v) => ({
      ...v,
      is_new: isNewSubscriptionUpload(v.created_at),
    }));

    return res.json({ successful: true, data, has_more: page.has_more, next_cursor: page.next_cursor });
  } catch (err) {
    next(err);
  }
});

async function signCreatorPickThumbnail(blobName) {
  if (!blobName) return null;
  try {
    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    return generateVideoReadSAS(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails', blobName);
  } catch (err) {
    console.warn('[creator-picks] thumbnail SAS failed:', err?.message || err);
    return null;
  }
}

const CREATOR_PICK_INCLUDE = {
  channel: { select: RECOMMENDER_SELECT },
  video: { select: CREATOR_PICK_VIDEO_SELECT },
  target_channel: { select: CREATOR_PICK_CHANNEL_SELECT },
};

/** Subscribed creators' recent Creator's Choice picks (card-only, no playback URLs). */
router.get('/subscriptions/creator-picks', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const { limit, excludeId } = parseSubscriberPicksQuery(req.query);
    const { decodeCursor, encodeCursor } = await import('../utils/video-pagination.js');
    let cursor = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor?.created_at || !Number.isFinite(new Date(cursor.created_at).getTime()) || !Number.isInteger(cursor?.pick_id)) {
        return res.status(400).json({ successful: false, message: 'Invalid creator picks cursor.' });
      }
    }

    const subs = await prisma.subscription.findMany({
      where: { user_id },
      select: { channel_id: true },
    });
    const channelIds = subs.map((s) => s.channel_id).filter((id) => id != null);
    if (channelIds.length === 0) {
      return res.json({ successful: true, data: [] });
    }

    const scanLimit = Math.min(limit * 3, 72);
    const rows = await prisma.channel_creator_pick.findMany({
      where: {
        channel_id: { in: channelIds },
        ...(cursor ? {
          OR: [
            { created_at: { lt: new Date(cursor.created_at) } },
            { created_at: new Date(cursor.created_at), pick_id: { lt: cursor.pick_id } },
          ],
        } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { pick_id: 'desc' }],
      take: scanLimit + 1,
      include: CREATOR_PICK_INCLUDE,
    });

    const hasMoreRawRows = rows.length > scanLimit;
    const scanned = rows.slice(0, scanLimit);

    const eligible = dedupeSubscriberPicks(filterSubscriberPickRows(scanned, { excludeId }));
    const filtered = capSubscriberPicks(eligible, limit);

    const data = [];
    for (const row of filtered) {
      const card = toCreatorPickCard(row, () => null);
      if (!card) continue;
      if (row.video?.thumbnail_url) {
        card.video.thumbnail_url = await signCreatorPickThumbnail(row.video.thumbnail_url);
      }
      data.push(card);
    }

    res.setHeader('Cache-Control', 'private, max-age=30');
    // If filtering produced more than one output page, advance only through the last row
    // actually returned. Advancing through the entire scan would silently skip valid picks.
    const cursorRow = filtered.length === limit
      ? filtered[filtered.length - 1]
      : scanned[scanned.length - 1];
    const hasMore = eligible.length > limit || hasMoreRawRows;
    return res.json({
      successful: true,
      data,
      has_more: hasMore,
      next_cursor: hasMore && cursorRow
        ? encodeCursor({ created_at: cursorRow.created_at, pick_id: cursorRow.pick_id })
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/** List the authenticated creator's picks (manage view). */
router.get('/me/creator-picks', authenticateToken, async (req, res, next) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'No channel found.' });
    }

    const rows = await prisma.channel_creator_pick.findMany({
      where: { channel_id: channel.channel_id },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
      include: CREATOR_PICK_INCLUDE,
    });

    const data = [];
    for (const row of rows) {
      const item = toCreatorManagePick(row, () => null);
      if (item.video?.video_id && row.video?.thumbnail_url) {
        item.video.thumbnail_url = await signCreatorPickThumbnail(row.video.thumbnail_url);
      }
      data.push(item);
    }

    return res.json({ successful: true, data });
  } catch (err) {
    next(err);
  }
});

/** Add a Creator's Choice pick — must recommend another creator's video or channel. */
router.post('/me/creator-picks', authenticateToken, async (req, res, next) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'No channel found.' });
    }

    const parsed = parseCreatePickBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.message });
    }

    const existingCount = await prisma.channel_creator_pick.count({
      where: { channel_id: channel.channel_id },
    });
    if (existingCount >= MAX_CREATOR_PICKS) {
      return res.status(400).json({
        successful: false,
        message: `You can recommend at most ${MAX_CREATOR_PICKS} items.`,
      });
    }

    const note = parsed.note ? xss(parsed.note) : null;

    if (parsed.pick_type === 'video') {
      const video = await prisma.video.findUnique({
        where: { video_id: parsed.video_id },
        select: {
          video_id: true,
          channel_id: true,
          status: true,
          processing_status: true,
          channel: {
            select: {
              is_active: true,
              user: { select: { social_profiles: { select: { is_banned: true } } } },
            },
          },
        },
      });
      if (!video || video.status !== 'safe' || video.processing_status !== 'done') {
        return res.status(404).json({ successful: false, message: 'Video not found or not published.' });
      }
      if (video.channel_id === channel.channel_id) {
        return res.status(400).json({ successful: false, message: 'Recommend a video from another creator.' });
      }
      if (!video.channel?.is_active || video.channel?.user?.social_profiles?.is_banned) {
        return res.status(400).json({ successful: false, message: 'That creator is not available.' });
      }

      const created = await prisma.channel_creator_pick.create({
        data: {
          channel_id: channel.channel_id,
          pick_type: 'video',
          video_id: parsed.video_id,
          note,
          sort_order: existingCount,
        },
        include: CREATOR_PICK_INCLUDE,
      });

      const data = toCreatorManagePick(created, () => null);
      if (data.video?.video_id && created.video?.thumbnail_url) {
        data.video.thumbnail_url = await signCreatorPickThumbnail(created.video.thumbnail_url);
      }
      return res.status(201).json({ successful: true, data });
    }

    const target = await prisma.channel.findUnique({
      where: { channel_id: parsed.target_channel_id },
      select: {
        channel_id: true,
        is_active: true,
        user: { select: { social_profiles: { select: { is_banned: true } } } },
      },
    });
    if (!target?.is_active) {
      return res.status(404).json({ successful: false, message: 'Channel not found.' });
    }
    if (target.channel_id === channel.channel_id) {
      return res.status(400).json({ successful: false, message: 'Recommend another creator\'s channel.' });
    }
    if (target.user?.social_profiles?.is_banned) {
      return res.status(400).json({ successful: false, message: 'That creator is not available.' });
    }

    const created = await prisma.channel_creator_pick.create({
      data: {
        channel_id: channel.channel_id,
        pick_type: 'channel',
        target_channel_id: parsed.target_channel_id,
        note,
        sort_order: existingCount,
      },
      include: CREATOR_PICK_INCLUDE,
    });

    const data = toCreatorManagePick(created, () => null);
    return res.status(201).json({ successful: true, data });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ successful: false, message: 'You already recommend that item.' });
    }
    next(err);
  }
});

router.delete('/me/creator-picks/:pick_id', authenticateToken, async (req, res, next) => {
  try {
    const parsed = parsePickIdParam(req.params.pick_id);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.message });
    }

    const channel = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'No channel found.' });
    }

    const existing = await prisma.channel_creator_pick.findFirst({
      where: { pick_id: parsed.pick_id, channel_id: channel.channel_id },
      select: { pick_id: true },
    });
    const owned = ownedCreatorPickOr404(existing);
    if (!owned.ok) {
      return res.status(owned.status).json({ successful: false, message: owned.message });
    }

    await prisma.channel_creator_pick.delete({ where: { pick_id: owned.pick_id } });
    return res.json({ successful: true, message: 'Pick removed.' });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ successful: false, message: 'Pick not found.' });
    }
    next(err);
  }
});

router.post('/:channel_id/subscribe', authenticateToken, async (req, res, next) => {
  try {
    const channel_id = Number(req.params.channel_id);
    if (Number.isNaN(channel_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid channel id.' });
    }
    const user_id = req.user.user_id;

    const target = await prisma.channel.findUnique({ where: { channel_id }, select: { user_id: true } });
    if (!target) {
      return res.status(404).json({ successful: false, message: 'Channel not found.' });
    }
    if (target.user_id === user_id) {
      return res.status(400).json({ successful: false, message: "You can't subscribe to your own channel." });
    }

    const lockKey = `sub:lock:${user_id}:${channel_id}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 3, 'NX');
    // Only treat a null reply as a genuine "lock held" when Redis is actually up; when Redis is
    // unavailable (no managed Redis on prod) the client returns null as a no-op and we must NOT
    // 429 — otherwise every subscribe/unsubscribe is rejected. The de-dupe below is idempotent.
    if (isRedisReady() && acquired === null) {
      return res.status(429).json({ successful: false, message: 'Too many requests' });
    }

    const existing = await prisma.subscription.findUnique({ where: { user_id_channel_id: { user_id, channel_id } } });
    if (existing) {
      const count = await prisma.subscription.count({ where: { channel_id } });
      await redis.del(lockKey);
      return res.json({ successful: true, subscribed: true, action: 'already_subscribed', subscriber_count: count });
    }

    await prisma.subscription.create({ data: { user_id, channel_id } });
    const count = await prisma.subscription.count({ where: { channel_id } });

    const profile = await prisma.social_profile.findUnique({
      where: { user_id },
      select: { profile_id: true }
    });
    if (profile?.profile_id) {
      const { refreshInterestProfile } = await import('../utils/recommendation-engine.js');
      refreshInterestProfile(profile.profile_id, user_id).catch(() => {});
    }

    const io = req.app.get('io');
    io?.to(`user-${target.user_id}`).emit('new-subscriber', {
      user_id,
      subscriber_name: req.user.name,
      subscriber_count: count
    });

    await redis.del(lockKey);
    res.json({ successful: true, subscribed: true, action: 'subscribed', subscriber_count: count });
  } catch (err) { 
    next(err); 
  }
});

router.delete('/:channel_id/subscribe', authenticateToken, async (req, res, next) => {
  try {
    const channel_id = Number(req.params.channel_id);
    if (Number.isNaN(channel_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid channel id.' });
    }
    const user_id = req.user.user_id;

    const lockKey = `sub:lock:${user_id}:${channel_id}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 3, 'NX');
    // Only treat a null reply as a genuine "lock held" when Redis is actually up; when Redis is
    // unavailable (no managed Redis on prod) the client returns null as a no-op and we must NOT
    // 429 — otherwise every subscribe/unsubscribe is rejected. The de-dupe below is idempotent.
    if (isRedisReady() && acquired === null) {
      return res.status(429).json({ successful: false, message: 'Too many requests' });
    }

    await prisma.subscription.deleteMany({ where: { user_id, channel_id } });
    const count = await prisma.subscription.count({ where: { channel_id } });

    await redis.del(lockKey);
    res.json({ successful: true, subscribed: false, action: 'unsubscribed', subscriber_count: count });
  } catch (err) { 
    next(err); 
  }
});

router.get('/:channel_id/subscription-status', authenticateToken, async (req, res, next) => {
  try {
    const channel_id = Number(req.params.channel_id);
    if (Number.isNaN(channel_id)) {
      return res.status(400).json({ subscribed: false, message: 'Invalid channel id.' });
    }
    const user_id = req.user.user_id;
    const sub = await prisma.subscription.findUnique({ where: { user_id_channel_id: { user_id, channel_id } } });
    res.json({ subscribed: !!sub });
  } catch (err) { 
    next(err); 
  }
});







/**
 * 1. GET /channel/me/videos
 * Content Tab එකෙහි චැනලයට අදාළ සියලුම වීඩියෝ පිටු ක්‍රමයට (Paginated) ලබා ගැනීම.
 */
router.get('/me/videos', authenticateToken, async (req, res, next) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
    if (!channel) return res.status(404).json({ successful: false, message: 'Channel not found.' });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const skip = Math.max(parseInt(req.query.offset) || 0, 0);

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        where: { channel_id: channel.channel_id },
        orderBy: { created_at: 'desc' },
        take: limit,
        skip,
        select: {
          video_id: true,
          title: true,
          thumbnail_url: true,
          views_count: true,
          video_type: true,
          status: true,
          created_at: true,
          // The creator's own listing intentionally has no status filter, so it must report the real
          // state — otherwise a still-processing / failed / removed video is indistinguishable from a
          // live one and reads as "Published" when no viewer can see it.
          processing_status: true,
          hls_url: true,
          channel: {
            select: {
              is_active: true,
              user: { select: { social_profiles: { select: { is_banned: true } } } }
            }
          },
        }
      }),
      prisma.video.count({ where: { channel_id: channel.channel_id } })
    ]);

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    const mappedVideos = videos.map(({ channel: _guard, hls_url, ...v }) => ({
      ...v,
      visibility: creatorVisibility({ ...v, hls_url, channel: _guard }),
      thumbnail_url: v.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null
    }));

    return res.json({
      successful: true,
      data: {
        videos: mappedVideos,
        total_count: total,
        has_more: skip + limit < total
      }
    });
  } catch (err) { next(err); }
});

/**
 * 2. GET /channel/me/videos/recent
 */
router.get('/me/videos/recent', authenticateToken, async (req, res, next) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { user_id: req.user.user_id } });
    if (!channel) return res.status(404).json({ successful: false, message: 'Channel not found.' });

    const recentVideos = await prisma.video.findMany({
      where: { channel_id: channel.channel_id, status: 'safe' },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: {
        video_id: true,
        title: true,
        thumbnail_url: true,
        views_count: true,
        created_at: true,
      }
    });

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    const mapped = recentVideos.map(v => ({
      ...v,
      thumbnail_url: v.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null
    }));

    return res.json({ successful: true, data: mapped });
  } catch (err) { next(err); }
});

/**
 * 3. GET /channel/me/wallet/transactions
 * Wallet Tab එකෙහි ඇති "ORDER HISTORY" table එක පිරවීම සඳහා පරිශීලකයාගේ ගනුදෙනු ලැයිස්තුව ලබා ගැනීම.
 */
router.get('/me/wallet/transactions', authenticateToken, async (req, res, next) => {
  try {
    const transactions = await prisma.wallet_transaction.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        transaction_id: true,
        amount: true,
        type: true,
        source: true,
        status: true,
        description: true,
        created_at: true,
        external_ref: true,
      }
    });

    return res.json({ successful: true, data: transactions });
  } catch (err) { next(err); }
});

/**
 * 4. POST /channel/me/wallet/withdraw
 * Wallet Tab එකෙහි ඇති "Withdraw" බොත්තම ක්‍රියාත්මක කර මුදල් ලබා ගැනීමට ඉල්ලුම් කිරීම (Payout Request).
 */
router.post('/me/wallet/withdraw', authenticateToken, async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid payout amount.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Locking the wallet for safe concurrency
      await tx.$executeRaw`SELECT * FROM "strug_wallet" WHERE "user_id" = ${req.user.user_id} FOR UPDATE`;

      const wallet = await tx.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
      if (!wallet || Number(wallet.balance) < amount) {
        throw new Error('INSUFFICIENT_WALLET_BALANCE');
      }

      // Deduct the wallet balance
      await tx.strug_wallet.update({
        where: { user_id: req.user.user_id },
        data: { balance: { decrement: amount } }
      });

      // Create a withdraw debit transaction record
      const txn = await tx.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: -amount,
          type: 'debit',
          source: 'payout_withdrawal',
          status: 'pending', // Pending admin approval on Task Board
          description: `Payout withdrawal request of $${amount.toFixed(2)} submitted.`
        }
      });

      // Create a task on the Admin Board for approval
      await tx.board_task.create({
        data: {
          title: `Payout Approval Request: User #${req.user.user_id}`,
          description: `Creator ${req.user.name} has requested a payout of $${amount.toFixed(2)}. Transaction Ref: #${txn.transaction_id}`,
          status: 'backlog',
          priority: 'high',
          vertical: 'finance',
          assigner_id: 1,
          source_type: 'payout',
          source_id: txn.transaction_id
        }
      });

      return txn;
    }, {
      maxWait: 10000,
      timeout: 15000
    });

    return res.json({ successful: true, message: 'Payout request submitted successfully!', transaction: result });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_WALLET_BALANCE') {
      return res.status(400).json({ successful: false, message: 'Insufficient funds in your wallet.' });
    }
    next(err);
  }
});

/**
 * 5. GET /channel/me/referral
 * Overview & Earnings Tab එකෙහි "YOUR REFERRAL CODE" සහ "USERNAME ALSO WORKS AS A CODE" කාඩ් පිරවීම.
 */
router.get('/me/referral', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: { ref_code: true, username: true }
    });

    if (!user) return res.status(404).json({ successful: false, message: 'User not found.' });

    const totalReferrals = await prisma.shared_ref_code.count({
      where: { ref_code: user.ref_code },
    });

    // Real Recruit earnings (new source:'recruit' + legacy source:'referral').
    const earnAgg = await prisma.wallet_transaction.aggregate({
      _sum: { amount: true },
      where: {
        user_id: req.user.user_id,
        source: { in: ['recruit', 'referral'] },
      },
    });
    const commissionEarned = Number(earnAgg._sum?.amount || 0);

    return res.json({
      successful: true,
      data: {
        referral_code: user.ref_code,
        username_code: user.username,
        total_successful_referrals: totalReferrals,
        commission_earned: commissionEarned,
        currency: 'CAD',
        // Deprecated fake field — kept as 0 so old clients don't show invented LKR.
        commission_earned_lkr: 0,
      },
    });
  } catch (err) { next(err); }
});







router.get('/me/monetization-status', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: {
        _count: { select: { subscriptions: true } },
        videos: { select: { video_id: true } }
      }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: "Channel not found." });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    const watchData = await prisma.video_analytics.aggregate({
      where: { video_id: { in: videoIds } },
      _sum: { watch_time_sec: true }
    });

    const watchHours = (watchData._sum.watch_time_sec || 0) / 3600;
    const subCount = channel._count.subscriptions;
    const isEligible = subCount >= 1000 && watchHours >= 3000;

    res.json({
      successful: true,
      data: {
        current_subs: subCount,
        required_subs: 1000,
        current_watch_hours: parseFloat(watchHours.toFixed(2)),
        required_watch_hours: 3000,
        is_eligible: isEligible,
        is_verified: channel.is_verified,
        progress_percentage: Math.min(((watchHours / 3000) * 100), 100).toFixed(1)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/request-verification', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const channel = await prisma.channel.findUnique({
      where: { user_id },
      include: { _count: { select: { subscriptions: true } }, videos: { select: { video_id: true } } }
    });

    if (!channel) return res.status(404).json({ successful: false, message: "Channel not found." });

    if (channel.is_verified) {
      return res.status(400).json({ successful: false, message: "Channel is already verified." });
    }

    const videoIds = channel.videos.map(v => v.video_id);
    const watchData = await prisma.video_analytics.aggregate({
      where: { video_id: { in: videoIds } },
      _sum: { watch_time_sec: true }
    });

    const watchHours = (watchData._sum.watch_time_sec || 0) / 3600;

    if (channel._count.subscriptions < 1000 || watchHours < 3000) {
      return res.status(400).json({ successful: false, message: "Milestones not met yet. Requires 1000 subs and 3000 watch hours." });
    }

    let streamer = await prisma.live_streamer_profile.findUnique({ where: { user_id } });
    if (!streamer) {
      streamer = await prisma.live_streamer_profile.create({
        data: {
          user_id,
          category_id: 1,
          handle: channel.handle,
          display_name: channel.display_name
        }
      });
    }

    const existingRequest = await prisma.live_monetization_request.findFirst({
      where: { streamer_id: streamer.streamer_id, status: 'PENDING' }
    });

    if (existingRequest) {
      return res.status(409).json({ successful: false, message: "A verification request is already pending." });
    }

    const request = await prisma.live_monetization_request.create({
      data: {
        streamer_id: streamer.streamer_id,
        status: 'PENDING'
      }
    });

    res.status(201).json({ successful: true, message: "Verification request submitted successfully!", data: request });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/verification/:request_id/resolve', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const request_id = Number(req.params.request_id);
    const { action, note } = req.body;

    if (Number.isNaN(request_id)) {
      return res.status(400).json({ successful: false, message: "Invalid request ID format." });
    }

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ successful: false, message: "Action must be APPROVE or REJECT." });
    }

    const request = await prisma.live_monetization_request.findUnique({
      where: { request_id },
      include: { streamer: true }
    });

    if (!request) {
      return res.status(404).json({ successful: false, message: "Verification request not found." });
    }

    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    await prisma.$transaction([
      prisma.live_monetization_request.update({
        where: { request_id },
        data: { status: newStatus, admin_note: note || null, resolved_at: new Date() }
      }),
      prisma.live_streamer_profile.update({
        where: { streamer_id: request.streamer_id },
        data: { monetization_status: newStatus, is_verified: action === 'APPROVE' }
      }),
      prisma.channel.update({
        where: { user_id: request.streamer.user_id },
        data: { is_verified: action === 'APPROVE' }
      })
    ]);

    // Same gap as live-monetization-routes: the creator was never told the outcome.
    if (request.streamer?.user_id) {
      const approved = action === 'APPROVE';
      notify(req.app.get('io'), {
        userId: request.streamer.user_id,
        vertical: 'system',
        type: approved ? 'application.approved' : 'application.rejected',
        title: approved ? 'Your channel was verified' : 'Your verification request was rejected',
        body: note || null,
        urgency: 'ambient',
        entityType: 'live_monetization_request',
        entityId: request_id,
        actionUrl: 'videos',
      });
    }

    res.json({ successful: true, message: `Request successfully ${action.toLowerCase()}d!` });
  } catch (err) {
    next(err);
  }
});

export default router;
