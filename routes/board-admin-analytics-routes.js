// routes/board-admin-analytics-routes.js
//
// Read-only Data & Analytics data for the internal dashboards (strug-internal-dashboards
// → Data & Analytics dashboard). Gated by the board identity + can_manage_members (the
// admin tier), matching Finance / Operations / Vertical Management / Customer Support.
//
// Mounted at /board-admin/analytics. ALL endpoints are READ-ONLY.
//
// Data & Analytics is mostly an AGGREGATION / PRESENTATION layer: the cross-cutting
// "numbers" dashboard (platform KPIs, audience, commerce/GMV, per-vertical demand,
// content/engagement, growth). The vast majority of it is composed FRONTEND-SIDE from
// the board-admin endpoints the other dashboards already ship (users / finance /
// operations / vertical-management / customer-support). The ONE data domain not yet
// surfaced anywhere is content/video engagement — so this router adds just that:
//
//   GET /content   video & content-engagement aggregates: counts (videos / channels /
//                  views / comments / likes / subscriptions / monetization), processing
//                  + type + category breakdowns, top videos, a real daily uploads/views
//                  time-series (video.created_at + video_view.viewed_at), and a viewer
//                  geography breakdown (video_analytics.viewer_country).
//
// The rest of the dashboard (Home/Executive rollups, Marketplace, Audience, Provider,
// Financial, Operations, CX analytics) is FE-composed from existing endpoints — no new
// backend, which keeps this router thin and dodges deploy risk for everything but the
// genuinely-new content data.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import {
  buildAnalyticsOverview,
  buildMetricsCatalog,
} from '../services/board-analytics-overview.js';
import { clampAnalyticsDays } from '../utils/analytics-metrics.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('analytics', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// GET /overview — Phase 0 server-composed executive KPIs (replaces FE fan-out).
// ?days=7|30|90 (default 30). Includes prior-period deltas + drilldown map.
router.get('/overview', async (req, res) => {
  try {
    const days = clampAnalyticsDays(req.query.days);
    const payload = await buildAnalyticsOverview(prisma, { days });
    res.json(payload);
  } catch (err) {
    console.error('[board-admin/analytics] /overview failed:', err);
    res.status(500).json({ successful: false, message: 'Failed to load analytics overview' });
  }
});

// GET /metrics — KPI dictionary (SSOT) for the Metric Definitions view.
router.get('/metrics', async (_req, res) => {
  try {
    res.json(buildMetricsCatalog());
  } catch (err) {
    console.error('[board-admin/analytics] /metrics failed:', err);
    res.status(500).json({ successful: false, message: 'Failed to load metrics catalog' });
  }
});

// GET /content — video & content-engagement metrics. ?days (7..180, default 30) scopes
// the recent-views figure and the daily time-series window.
router.get('/content', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 180, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000); // bound in JS (no make_interval)

    const [
      videos, channels, totalViewsAgg, adRevenueAgg, recentViews,
      comments, likes, subscriptions, monetizable, shorts, longs,
      byProcessingRaw, byStatusRaw, byTypeRaw, byCategoryRaw,
      topVideos, geoRaw, dailyUploads, dailyViews,
    ] = await Promise.all([
      prisma.video.count(),
      prisma.channel.count(),
      prisma.video.aggregate({ _sum: { views_count: true } }),
      prisma.video.aggregate({ _sum: { ad_revenue: true } }),
      prisma.video_view.count({ where: { viewed_at: { gte: cutoff } } }),
      prisma.video_comments.count(),
      prisma.video_likes.count({ where: { is_like: true } }),
      prisma.subscription.count(),
      prisma.video.count({ where: { is_monetizable: true } }),
      prisma.video.count({ where: { video_type: 'short' } }),
      prisma.video.count({ where: { video_type: 'long' } }),
      prisma.video.groupBy({ by: ['processing_status'], _count: { _all: true } }),
      prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.video.groupBy({ by: ['video_type'], _count: { _all: true } }),
      prisma.video.groupBy({ by: ['category'], _count: { _all: true }, orderBy: { _count: { category: 'desc' } }, take: 12 }),
      prisma.video.findMany({
        orderBy: { views_count: 'desc' },
        take: 10,
        select: {
          video_id: true, title: true, views_count: true, category: true, video_type: true,
          created_at: true, processing_status: true,
          channel: { select: { display_name: true, handle: true } },
        },
      }),
      prisma.video_analytics.groupBy({
        by: ['viewer_country'], _count: { _all: true },
        where: { viewer_country: { not: null } },
        orderBy: { _count: { viewer_country: 'desc' } }, take: 12,
      }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS uploads
        FROM video WHERE created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', viewed_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS views
        FROM video_view WHERE viewed_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
    ]);

    // merge the two daily series on date
    const dayMap = new Map();
    for (const r of dailyUploads) dayMap.set(r.date, { date: r.date, uploads: num(r.uploads), views: 0 });
    for (const r of dailyViews) {
      const e = dayMap.get(r.date) || { date: r.date, uploads: 0, views: 0 };
      e.views = num(r.views);
      dayMap.set(r.date, e);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    const mapGroup = (rows, key) =>
      rows
        .map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
        .sort((a, b) => b.count - a.count);

    res.json({
      days,
      totals: {
        videos, channels,
        totalViews: num(totalViewsAgg._sum.views_count),
        recentViews,
        comments, likes, subscriptions, monetizable, shorts, longs,
        adRevenue: num(adRevenueAgg._sum.ad_revenue),
      },
      byProcessing: mapGroup(byProcessingRaw, 'processing_status'),
      byStatus: mapGroup(byStatusRaw, 'status'),
      byType: mapGroup(byTypeRaw, 'video_type'),
      byCategory: mapGroup(byCategoryRaw, 'category'),
      topVideos: topVideos.map((v) => ({
        video_id: v.video_id,
        title: v.title,
        views: num(v.views_count),
        category: v.category,
        video_type: v.video_type,
        processing_status: v.processing_status,
        channel: v.channel?.display_name || (v.channel?.handle ? `@${v.channel.handle}` : null),
        created_at: v.created_at,
      })),
      geo: geoRaw.map((r) => ({ name: r.viewer_country, count: num(r._count?._all) })),
      daily,
      note: 'Content & engagement metrics over the video catalog. Total views is the cumulative views_count; recent views, the daily views series and viewer geography come from the per-view (video_view) + analytics (video_analytics) tables over the selected window.',
    });
  } catch (err) {
    console.error('[board-admin/analytics] /content failed:', err);
    res.status(500).json({ error: 'Failed to load content analytics' });
  }
});

// GET /channels-audit — read-only per-channel ownership sweep. Answers "did creator
// dashboards get merged / did a creator lose access to his videos?" decisively across
// EVERY channel, and surfaces test-account / test-video sprawl.
//
// Structural facts baked into the schema (so some anomalies are impossible by design and
// are reported as such rather than scanned): channel.user_id is @unique (a user owns AT
// MOST one channel), and `video` has NO uploader/owner column — a video belongs to
// exactly one channel via channel_id, which belongs to exactly one user. So a video can
// never be "merged" into two dashboards; ownership is a strict video → channel → user
// 1:N:1 chain. This endpoint proves that holds in the live data and flags the only real
// risks left: placeholder auto-provisioned accounts and empty channels.
router.get('/channels-audit', async (req, res) => {
  try {
    const [channels, videoCounts, totalUsers] = await Promise.all([
      prisma.channel.findMany({
        select: {
          channel_id: true, user_id: true, handle: true, display_name: true,
          is_active: true, created_at: true,
          user: { select: { user_id: true, name: true, email: true } },
        },
        orderBy: { channel_id: 'asc' },
      }),
      prisma.video.groupBy({ by: ['channel_id'], _count: { _all: true } }),
      prisma.user.count(),
    ]);

    const vidByChannel = new Map(videoCounts.map((r) => [r.channel_id, num(r._count?._all)]));
    // Placeholder accounts = the known GET /me auto-provision hotfix (names like "user42").
    const isPlaceholder = (name) => typeof name === 'string' && /^user\d+$/i.test(name.trim());

    const rows = channels.map((c) => {
      const video_count = vidByChannel.get(c.channel_id) || 0;
      const owner_name = c.user?.name ?? null;
      return {
        channel_id: c.channel_id,
        user_id: c.user_id,
        handle: c.handle,
        display_name: c.display_name,
        owner_name,
        owner_has_email: c.user?.email != null,
        video_count,
        is_active: c.is_active,
        created_at: c.created_at,
        is_placeholder_owner: isPlaceholder(owner_name),
        is_empty: video_count === 0,
      };
    });

    // Anomaly (i): any user_id owning >1 channel — impossible under channel.user_id @unique,
    // scanned anyway so a regression would show up rather than hide.
    const byUser = new Map();
    for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) || 0) + 1);
    const multiChannelUsers = [...byUser.entries()].filter(([, n]) => n > 1).map(([user_id, count]) => ({ user_id, count }));

    const placeholderChannels = rows.filter((r) => r.is_placeholder_owner);
    const emptyChannels = rows.filter((r) => r.is_empty);
    const totalVideosOwned = rows.reduce((s, r) => s + r.video_count, 0);

    res.json({
      summary: {
        totalChannels: rows.length,
        totalUsers,
        totalVideosOwned,
        channelsWithVideos: rows.length - emptyChannels.length,
        emptyChannels: emptyChannels.length,
        placeholderOwnedChannels: placeholderChannels.length,
      },
      anomalies: {
        // Non-empty ⇒ a real integrity problem. Expected empty on a healthy dataset.
        multiChannelUsers,
        // Placeholder + empty channels are benign test-sprawl, listed for visibility.
        placeholderChannels: placeholderChannels.map((r) => ({
          channel_id: r.channel_id, user_id: r.user_id, handle: r.handle,
          owner_name: r.owner_name, video_count: r.video_count,
        })),
      },
      guarantees: {
        note: 'channel.user_id is @unique (one channel per user) and video has no independent owner column — ownership is a strict video→channel→user chain, so cross-account "merged dashboards" are structurally impossible. multiChannelUsers should always be empty; a non-empty array means a schema regression.',
        crossOwnershipPossible: false,
      },
      channels: rows,
    });
  } catch (err) {
    console.error('[board-admin/analytics] /channels-audit failed:', err);
    res.status(500).json({ error: 'Failed to load channels audit' });
  }
});

export default router;
