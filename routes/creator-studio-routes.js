// routes/creator-studio-routes.js
// Integrated and finalized production-grade router for the Strug Creator Studio Dashboard

import express from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { BlobServiceClient } from '@azure/storage-blob';
import { buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { creatorVisibility } from '../utils/video-visibility.js';
import { invalidateVideoCaches } from '../utils/video-cache.js';
import { enqueueYoutubeImport } from '../utils/azure-queue.js';
import { normalizeYoutubeSourceUrl } from '../utils/youtube-source.js';
import {
  YOUTUBE_IMPORT_BUSY,
  isYoutubeImportBusy,
  isYoutubeImportStale,
  youtubeImportCancelMessage,
  youtubeImportStaleMessage,
} from '../utils/youtube-import-job.js';

// Prevents BigInt serialization errors during JSON responses
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const router = express.Router();

// Azure Blob Client initialization
const azureConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
const blobServiceClient = azureConnectionString
    ? BlobServiceClient.fromConnectionString(azureConnectionString)
    : null;
if (!blobServiceClient) {
    console.warn('[creator-studio] AZURE_STORAGE_CONNECTION_STRING is not set; blob cleanup for creator media is disabled.');
}

const withPlayUrl = (v) => ({
    ...v,
    processed_video_url: v.hls_url ?? (v.raw_video_url && v.raw_video_url !== 'pending_upload' ? v.raw_video_url : null),
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

/**
 * 1. DASHBOARD OVERVIEW (Unified /overview endpoint for the Overview tab)
 */
router.get('/overview', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const channel = await prisma.channel.findUnique({
            where: { user_id },
            include: {
                _count: { select: { videos: true, subscriptions: true } },
                videos: {
                    where: { status: 'safe' },
                    select: {
                        video_id: true,
                        title: true,
                        thumbnail_url: true,
                        views_count: true,
                        created_at: true,
                        _count: { select: { video_likes: true, video_comments: true } }
                    },
                    orderBy: { created_at: 'desc' }
                }
            }
        });

        if (!channel) return res.status(404).json({ successful: false, message: "Channel not found." });

        const totalViews = channel.videos.reduce((sum, v) => sum + (v.views_count || 0), 0);
        
        const videoIds = channel.videos.map(v => v.video_id);
        const [watchData, total_likes, total_comments] = await Promise.all([
            videoIds.length > 0
                ? prisma.video_analytics.aggregate({
                    where: { video_id: { in: videoIds } },
                    _sum: { watch_time_sec: true }
                })
                : Promise.resolve({ _sum: { watch_time_sec: 0 } }),
            videoIds.length > 0
                ? prisma.video_likes.count({ where: { video_id: { in: videoIds } } })
                : Promise.resolve(0),
            videoIds.length > 0
                ? prisma.video_comments.count({ where: { video_id: { in: videoIds } } })
                : Promise.resolve(0)
        ]);

        const video_count = channel.videos.length;
        const avg_views = video_count > 0 ? Math.round(totalViews / video_count) : 0;
        const engagement_rate = totalViews > 0
            ? parseFloat(Math.min((total_likes + total_comments) / totalViews * 100, 100).toFixed(1))
            : 0.0;

        const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
        const recentVideos = channel.videos.slice(0, 5).map(v => ({
            video_id: v.video_id,
            title: v.title,
            views: v.views_count,
            thumbnail_url: v.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null,
            created_at: v.created_at
        }));

        res.json({
            successful: true,
            data: {
                subscriber_count: channel._count.subscriptions,
                video_count,
                total_views: totalViews,
                avg_views,
                engagement_rate,
                watch_time_hours: parseFloat(((watchData._sum.watch_time_sec || 0) / 3600).toFixed(1)),
                recent_videos: recentVideos
            }
        });
    } catch (err) { next(err); }
});

/**
 * 2. LEGACY DASHBOARD OVERVIEW (Preserved for backward compatibility)
 */
router.get('/dashboard', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const channel = await prisma.channel.findUnique({
            where: { user_id },
            include: {
                _count: { select: { videos: true, subscriptions: true } },
                videos: {
                    select: { views_count: true, ad_revenue: true }
                }
            }
        });

        if (!channel) return res.status(404).json({ successful: false, message: "Channel not found." });

        const totalViews = channel.videos.reduce((sum, v) => sum + (v.views_count || 0), 0);
        const totalEarnings = channel.videos.reduce((sum, v) => sum + Number(v.ad_revenue || 0), 0);
        
        res.json({
            successful: true,
            data: {
                channel_name: channel.display_name,
                handle: channel.handle,
                is_verified: channel.is_verified,
                subscribers: channel._count.subscriptions,
                stats: {
                    total_videos: channel._count.videos,
                    total_views: totalViews,
                    total_earnings: totalEarnings.toFixed(2),
                    currency: "CAD"
                }
            }
        });
    } catch (err) { next(err); }
});

/**
 * 3. CONTENT MANAGER (Paginated List with Secure Thumbnail SAS URL support)
 */
router.get('/content', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 10;

        const channel = await prisma.channel.findUnique({ where: { user_id } });
        if (!channel) return res.status(404).json({ message: "Channel not found." });

        const [videos, total] = await prisma.$transaction([
            prisma.video.findMany({
                where: { channel_id: channel.channel_id },
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    _count: { select: { video_comments: true, video_likes: true } },
                    // Needed by creatorVisibility() to compute the REAL state below.
                    channel: {
                        select: {
                            is_active: true,
                            user: { select: { social_profiles: { select: { is_banned: true } } } }
                        }
                    }
                }
            }),
            prisma.video.count({ where: { channel_id: channel.channel_id } })
        ]);

        const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
        const mappedVideos = videos.map(v => {
            const wrapped = withPlayUrl(v);
            // This listing has NO status filter (by design — a creator must see their own failed and
            // removed uploads). But it previously returned no state either, so the UI rendered a
            // banned / errored / still-processing video identically to a live one, and creators
            // reported videos as "published" that no viewer could ever see. Tell the truth instead:
            // `visibility.state` is what the badge should render, and `visible_to_viewers` is the
            // single boolean the UI must use before it says "Published".
            const visibility = creatorVisibility(v);
            const { channel: _omitChannelGuard, ...rest } = wrapped;
            return {
                ...rest,
                visibility,
                thumbnail_url: v.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null
            };
        });

        res.json({
            successful: true,
            data: mappedVideos,
            pagination: {
                current_page: page,
                total_pages: Math.ceil(total / limit),
                total_items: total
            }
        });
    } catch (err) { next(err); }
});

/**
 * 4. CHANNEL DEMOGRAPHICS
 */
router.get('/analytics', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const channel = await prisma.channel.findUnique({ where: { user_id } });
        if (!channel) return res.status(404).json({ message: "Channel not found." });

        const demographics = await prisma.video_analytics.groupBy({
            by: ['viewer_country'],
            where: { video: { channel_id: channel.channel_id } },
            _count: { id: true },
            _sum: { watch_time_sec: true }
        });

        res.json({ successful: true, data: demographics });
    } catch (err) { next(err); }
});

/**
 * 5. CHANNEL TIMESERIES & TRENDS (For Analytics Sparklines & Performance Chart)
 */
router.get('/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const rangeParam = RANGE_DAYS[req.query.range] ? req.query.range : '28d';
    const isLifetime = rangeParam === 'lifetime';
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

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
    if (!channel) return res.status(404).json({ successful: false, message: 'Channel not found' });

    const videoIds = channel.videos.map(v => v.video_id);
    const buckets = buildDateBuckets(start, days);
    const bucketIndex = new Map(buckets.map((d, i) => [d, i]));

    if (videoIds.length === 0) {
      return res.json({
        successful: true,
        data: {
          range: rangeParam,
          summary: { total_views: 0, views_change_pct: null, total_subscribers: channel._count.subscriptions, net_subscribers: 0, subscribers_change_pct: null, total_likes: 0, total_comments: 0, engagement_rate: 0, engagement_change_pct: null, watch_time_minutes: 0, has_watch_time_data: false },
          timeseries: buckets.map(date => ({ date, views: 0, likes: 0, comments: 0, subscribers_net: 0 })),
          top_videos: [],
          category_breakdown: [],
        },
      });
    }

    const [analyticsRows, prevAnalyticsRows, likeRows, prevLikeRows, commentRows, prevCommentRows, subRows, prevSubRows] = await Promise.all([
      prisma.video_analytics.findMany({ where: { video_id: { in: videoIds }, created_at: { gte: start } }, select: { video_id: true, watch_time_sec: true, created_at: true } }),
      prisma.video_analytics.findMany({ where: { video_id: { in: videoIds }, created_at: { gte: prevStart, lte: prevEnd } }, select: { watch_time_sec: true } }),
      prisma.video_likes.findMany({ where: { video_id: { in: videoIds }, is_like: true, created_at: { gte: start } }, select: { video_id: true, created_at: true } }),
      prisma.video_likes.findMany({ where: { video_id: { in: videoIds }, is_like: true, created_at: { gte: prevStart, lte: prevEnd } }, select: { video_id: true } }),
      prisma.video_comments.findMany({ where: { video_id: { in: videoIds }, created_at: { gte: start } }, select: { video_id: true, created_at: true } }),
      prisma.video_comments.findMany({ where: { video_id: { in: videoIds }, created_at: { gte: prevStart, lte: prevEnd } }, select: { video_id: true } }),
      prisma.subscription.findMany({ where: { channel_id: channel.channel_id, created_at: { gte: start } }, select: { created_at: true } }),
      prisma.subscription.findMany({ where: { channel_id: channel.channel_id, created_at: { gte: prevStart, lte: prevEnd } }, select: { created_at: true } }),
    ]);

    const tsViews = new Array(buckets.length).fill(0);
    const tsLikes = new Array(buckets.length).fill(0);
    const tsComments = new Array(buckets.length).fill(0);
    const tsSubs = new Array(buckets.length).fill(0);

    analyticsRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(dayKey(r.created_at)); if (i != null) tsViews[i] += 1; });
    likeRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(dayKey(r.created_at)); if (i != null) tsLikes[i] += 1; });
    commentRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(dayKey(r.created_at)); if (i != null) tsComments[i] += 1; });
    subRows.forEach(r => { if (!r.created_at) return; const i = bucketIndex.get(dayKey(r.created_at)); if (i != null) tsSubs[i] += 1; });

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

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    const top_videos = channel.videos
      .map(v => {
        const a = aByVid.get(v.video_id) || { count: 0, watchSum: 0 };
        const avgWatch = a.count ? Math.round(a.watchSum / a.count) : null;
        return {
          video_id: v.video_id, title: v.title, thumbnail_url: v.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null,
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

    res.json({
      successful: true,
      data: {
        range: rangeParam,
        summary: {
          total_views,
          views_change_pct: pctChange(rangeViews, prevViews),
          total_subscribers: channel._count.subscriptions,
          net_subscribers: rangeNetSubs,
          subscribers_change_pct: pctChange(rangeNetSubs, prevSubs),
          total_likes: rangeLikes,
          total_comments: rangeComments,
          engagement_rate,
          engagement_change_pct: pctChange(engagement_rate, prevEngagementRate),
          watch_time_minutes: parseFloat((rangeWatchSec / 60).toFixed(1)),
          has_watch_time_data,
        },
        timeseries,
        top_videos,
        category_breakdown,
      },
    });
  } catch (err) { next(err); }
});

/**
 * 6. GET /creator-studio/earnings (Earnings timeseries and metrics)
 */
router.get('/earnings', authenticateToken, async (req, res, next) => {
  try {
    const rangeParam = RANGE_DAYS[req.query.range] ? req.query.range : '28d';
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const channel = await prisma.channel.findUnique({
      where: { user_id: req.user.user_id },
      include: { videos: { select: { video_id: true, title: true, thumbnail_url: true } } },
    });
    if (!channel) return res.status(404).json({ successful: false, message: 'Channel not found' });

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

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
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
        return { id: e.id, title: v?.title || 'Video', thumbnail_url: v?.thumbnail_url ? generateVideoReadSAS('thumbnails', v.thumbnail_url) : null, subtitle: 'Ad + subs', gross: round2(e.gross), net: round2(e.net), count: 0 }; 
      })
      .sort((a, b) => b.net - a.net)
      .slice(0, 8);

    res.json({
      successful: true,
      data: {
        range: rangeParam, currency: 'CAD',
        lifetime_net: round2(num(lifetimeAdAgg._sum.creator_share) + totalSubscriptionRevenue + totalDonations),
        summary, 
        timeseries, 
        breakdown, 
        top,
      },
    });
  } catch (err) { next(err); }
});

/**
 * 8. GET /creator-studio/wallet/transactions
 * Wallet History ගනුදෙනු ලැයිස්තුව ලබා ගැනීම.
 */
router.get('/wallet/transactions', authenticateToken, async (req, res, next) => {
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
 * 9. POST /creator-studio/wallet/withdraw
 * Available balance එක withdraw කිරීමට ඉල්ලුම් කිරීම.
 */
router.post('/wallet/withdraw', authenticateToken, async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid payout amount.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT * FROM "strug_wallet" WHERE "user_id" = ${req.user.user_id} FOR UPDATE`;

      const wallet = await tx.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
      if (!wallet || Number(wallet.balance) < amount) {
        throw new Error('INSUFFICIENT_WALLET_BALANCE');
      }

      await tx.strug_wallet.update({
        where: { user_id: req.user.user_id },
        data: { balance: { decrement: amount } }
      });

      const txn = await tx.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: -amount,
          type: 'debit',
          source: 'payout_withdrawal',
          status: 'pending',
          description: `Payout withdrawal request of $${amount.toFixed(2)} submitted.`
        }
      });

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
 * 10. GET /creator-studio/referral
 * Referral Code සහ Username Code metrics ලබා ගැනීම.
 */
router.get('/referral', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: { ref_code: true, username: true }
    });

    if (!user) return res.status(404).json({ successful: false, message: 'User not found.' });

    const totalReferrals = await prisma.shared_ref_code.count({
      where: { ref_code: user.ref_code }
    });

    return res.json({
      successful: true,
      data: {
        referral_code: user.ref_code,
        username_code: user.username,
        total_successful_referrals: totalReferrals,
        commission_earned_lkr: totalReferrals * 300.00
      }
    });
  } catch (err) { next(err); }
});

/**
 * 11. EDIT VIDEO METADATA (Backwards Compatibility)
 */
router.put('/video/:video_id', authenticateToken, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        const { title, description } = req.body;

        const video = await prisma.video.findFirst({
            where: { video_id, channel: { user_id: req.user.user_id } }
        });

        if (!video) return res.status(403).json({ successful: false, message: "Access Denied. You don't own this content." });

        const data = {};
        if (title !== undefined) {
            if (typeof title !== 'string' || !title.trim()) {
                return res.status(400).json({ successful: false, message: "Title must be a non-empty string." });
            }
            data.title = title.trim().slice(0, 200);
        }
        if (description !== undefined) {
            if (typeof description !== 'string') {
                return res.status(400).json({ successful: false, message: "Description must be a string." });
            }
            data.description = description.slice(0, 5000);
        }
        if (Object.keys(data).length === 0) {
            return res.status(400).json({ successful: false, message: "Nothing to update." });
        }

        const updated = await prisma.video.update({
            where: { video_id },
            data
        });

        res.json({ successful: true, message: "Video updated successfully.", data: updated });
    } catch (err) { next(err); }
});

/**
 * 12. DELETE VIDEO (Database + Azure Assets with Foreign Key Constraint fix)
 */
router.delete('/video/:video_id', authenticateToken, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        
        const video = await prisma.video.findFirst({
            where: { video_id, channel: { user_id: req.user.user_id } }
        });

        if (!video) return res.status(403).json({ message: "Unauthorized action." });

        await prisma.$transaction(async (tx) => {
            const commentRows = await tx.video_comments.findMany({
                where: { video_id },
                select: { comment_id: true }
            });
            const commentIds = commentRows.map(c => c.comment_id);

            if (commentIds.length > 0) {
                await tx.video_comment_likes.deleteMany({
                    where: { comment_id: { in: commentIds } }
                });
            }

            await tx.video_comments.deleteMany({ where: { video_id } });
            await tx.video_likes.deleteMany({ where: { video_id } });
            await tx.video_watch_later.deleteMany({ where: { video_id } });
            await tx.watch_history.deleteMany({ where: { video_id } });
            await tx.playlist_item.deleteMany({ where: { video_id } });
            await tx.video_analytics.deleteMany({ where: { video_id } });
            await tx.video.delete({ where: { video_id } });
        }, {
            maxWait: 10000,
            timeout: 15000
        });

        // #442: same as DELETE /video/:id — the cached feed/search/suggest responses would keep
        // serving this video (and the profile's channel grid reads the same cache) for minutes.
        await invalidateVideoCaches();

        if (blobServiceClient) {
            const processedContainer = blobServiceClient.getContainerClient(process.env.AZURE_PROCESSED_VIDEO_CONTAINER || 'videos-processed');
            const thumbContainer = blobServiceClient.getContainerClient(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails');

            (async () => {
                const hlsPrefix = `${video_id}/`;
                for await (const blob of processedContainer.listBlobsFlat({ prefix: hlsPrefix })) {
                    await processedContainer.deleteBlob(blob.name).catch(() => {});
                }
                if (video.thumbnail_url) {
                    const urlParts = video.thumbnail_url.split('/');
                    const thumbBlobName = urlParts.slice(4).join('/');
                    await thumbContainer.deleteBlob(thumbBlobName).catch(() => {});
                }
            })().catch((azureErr) => console.error(`[Azure-Cleanup-Error] for Video #${video_id}:`, azureErr.message));
        }

        res.json({ successful: true, message: "Video and cloud assets deleted permanently." });
    } catch (err) { next(err); }
});

const YOUTUBE_IMPORT_MAX = Math.min(2000, Math.max(1, Number(process.env.YOUTUBE_IMPORT_MAX || 800)));

function serializeImportJob(job) {
    if (!job) return null;
    return {
        job_id: job.job_id,
        source_url: job.source_url,
        status: job.status,
        total_found: job.total_found,
        imported_count: job.imported_count,
        skipped_count: job.skipped_count,
        failed_count: job.failed_count,
        error_message: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
        max_videos: YOUTUBE_IMPORT_MAX,
        busy: isYoutubeImportBusy(job.status),
    };
}

/**
 * If the worker died mid-import, status stays `importing` forever and blocks new starts.
 * Mark stale busy jobs as error so the creator can retry.
 */
async function finalizeStaleYoutubeImportJob(job) {
    if (!job || !isYoutubeImportStale(job)) return job;
    return prisma.youtube_import_job.update({
        where: { job_id: job.job_id },
        data: {
            status: 'error',
            error_message: youtubeImportStaleMessage().slice(0, 500),
        },
    });
}

/**
 * POST /creator-studio/youtube-import
 * Queue a background copy of a YouTube channel/playlist onto this creator's Strug channel.
 */
router.post('/youtube-import', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const source_url = normalizeYoutubeSourceUrl(req.body?.url || req.body?.source_url);

        const channel = await prisma.channel.findUnique({ where: { user_id } });
        if (!channel) {
            return res.status(404).json({ successful: false, message: 'Create a channel before importing.' });
        }

        const busy = await prisma.youtube_import_job.findFirst({
            where: { user_id, status: { in: [...YOUTUBE_IMPORT_BUSY] } },
            orderBy: { created_at: 'desc' },
        });
        const active = busy ? await finalizeStaleYoutubeImportJob(busy) : null;
        if (active && isYoutubeImportBusy(active.status)) {
            return res.status(409).json({
                successful: false,
                message: 'An import is already running. Cancel it or wait until it finishes.',
                data: serializeImportJob(active),
            });
        }

        const job = await prisma.youtube_import_job.create({
            data: { user_id, channel_id: channel.channel_id, source_url, status: 'queued' },
        });

        const queued = await enqueueYoutubeImport(job.job_id, 'list');
        if (!queued) {
            await prisma.youtube_import_job.update({
                where: { job_id: job.job_id },
                data: { status: 'error', error_message: 'Import queue is not configured' },
            });
            return res.status(503).json({ successful: false, message: 'Import queue is not available right now.' });
        }

        res.status(202).json({
            successful: true,
            message: 'Import started. Videos copy in the background — you can leave this page.',
            data: serializeImportJob(job),
        });
    } catch (err) {
        if (err.status === 400) {
            return res.status(400).json({ successful: false, message: err.message });
        }
        next(err);
    }
});

/** GET /creator-studio/youtube-import — latest job for this creator. */
router.get('/youtube-import', authenticateToken, async (req, res, next) => {
    try {
        let job = await prisma.youtube_import_job.findFirst({
            where: { user_id: req.user.user_id },
            orderBy: { created_at: 'desc' },
        });
        job = await finalizeStaleYoutubeImportJob(job);
        res.json({ successful: true, data: serializeImportJob(job) });
    } catch (err) { next(err); }
});

/**
 * POST /creator-studio/youtube-import/cancel
 * Mark the active busy job as error so the creator can start a new import.
 * Does not stop an in-flight worker mid-download, but clears the UI lock.
 */
router.post('/youtube-import/cancel', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const busy = await prisma.youtube_import_job.findFirst({
            where: { user_id, status: { in: [...YOUTUBE_IMPORT_BUSY] } },
            orderBy: { created_at: 'desc' },
        });
        if (!busy) {
            const latest = await prisma.youtube_import_job.findFirst({
                where: { user_id },
                orderBy: { created_at: 'desc' },
            });
            return res.json({
                successful: true,
                message: 'No import is running.',
                data: serializeImportJob(latest),
            });
        }

        const job = await prisma.youtube_import_job.update({
            where: { job_id: busy.job_id },
            data: {
                status: 'error',
                error_message: youtubeImportCancelMessage().slice(0, 500),
            },
        });

        res.json({
            successful: true,
            message: 'Import cancelled. You can start a new import.',
            data: serializeImportJob(job),
        });
    } catch (err) { next(err); }
});

export default router;
