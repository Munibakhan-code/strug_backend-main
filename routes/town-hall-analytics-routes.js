// routes/town-hall-analytics-routes.js
//
// Board #452: "Town hall currently stuck on organic post instead of providing by the user
// interaction or by the algorithm."
//
// Town Hall had NO creator analytics at all — social_feed posts have a whole
// social-analytics router, but a Town Hall author could only ever see the raw post. So the only
// thing a creator could judge was the post itself (its "organic" existence), never how people
// actually interacted with it or how far the ranking pushed it.
//
// The Town Hall FEED is already algorithmically ranked (see the personalization/diversity scoring in
// town-hall-routes.js) — what was missing is the creator's view of that. These endpoints expose the
// interaction signal the ranking itself consumes: views (reach), likes, replies and reposts, plus the
// engagement rate derived from them.
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

// Engagement rate = interactions / reach. Reach of 0 means nobody saw it, in which case the rate is
// 0 rather than a divide-by-zero or a misleading 100%.
function engagementRate({ likes, replies, reposts, views }) {
  const interactions = likes + replies + reposts;
  if (!views) return 0;
  return Number(((interactions / views) * 100).toFixed(2));
}

const POST_COUNTS = { select: { likes: true, replies: true, reposts: true } };

function shapePost(p) {
  const likes = p._count?.likes ?? 0;
  const replies = p._count?.replies ?? 0;
  const reposts = p._count?.reposts ?? 0;
  const views = p.view_count ?? 0;
  return {
    post_id: p.post_id,
    content: p.content,
    created_at: p.created_at,
    is_pinned: p.is_pinned,
    views,
    likes,
    replies,
    reposts,
    interactions: likes + replies + reposts,
    engagement_rate: engagementRate({ likes, replies, reposts, views }),
  };
}

/**
 * GET /town-hall-analytics/overview?days=30
 * Totals across the caller's own Town Hall posts, plus the best-performing one.
 */
router.get('/overview', authenticateToken, async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * DAY_MS);

    const posts = await prisma.town_hall_post.findMany({
      where: {
        user_id: req.user.user_id,
        created_at: { gte: since },
        // Replies are not "posts" for a creator's purposes — they'd inflate the counts and drag the
        // engagement rate down. Only top-level posts.
        parent_id: null,
      },
      select: {
        post_id: true, content: true, created_at: true, is_pinned: true, view_count: true,
        _count: POST_COUNTS,
      },
      orderBy: { created_at: 'desc' },
    });

    const shaped = posts.map(shapePost);
    const sum = (k) => shaped.reduce((acc, p) => acc + p[k], 0);
    const totals = {
      posts: shaped.length,
      views: sum('views'),
      likes: sum('likes'),
      replies: sum('replies'),
      reposts: sum('reposts'),
      interactions: sum('interactions'),
    };

    const best = shaped.length
      ? [...shaped].sort((a, b) => b.interactions - a.interactions || b.views - a.views)[0]
      : null;

    res.json({
      successful: true,
      data: {
        period_days: days,
        totals: {
          ...totals,
          engagement_rate: engagementRate({
            likes: totals.likes, replies: totals.replies, reposts: totals.reposts, views: totals.views,
          }),
          avg_views_per_post: shaped.length ? Math.round(totals.views / shaped.length) : 0,
        },
        top_post: best,
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /town-hall-analytics/top-posts?days=30&limit=10
 * The caller's posts ranked by the interaction signal, not by recency.
 */
router.get('/top-posts', authenticateToken, async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const since = new Date(Date.now() - days * DAY_MS);

    const posts = await prisma.town_hall_post.findMany({
      where: { user_id: req.user.user_id, created_at: { gte: since }, parent_id: null },
      select: {
        post_id: true, content: true, created_at: true, is_pinned: true, view_count: true,
        _count: POST_COUNTS,
      },
    });

    // Rank in JS: the interaction total is a computed sum across three separate relation counts,
    // which Prisma can't order by directly.
    const ranked = posts
      .map(shapePost)
      .sort((a, b) => b.interactions - a.interactions || b.views - a.views)
      .slice(0, limit);

    res.json({ successful: true, data: ranked });
  } catch (err) { next(err); }
});

/**
 * GET /town-hall-analytics/post/:id
 * Per-post breakdown. Owner-only — this is the author's own performance data.
 */
router.get('/post/:id', authenticateToken, async (req, res, next) => {
  try {
    const post_id = parseInt(req.params.id, 10);
    if (Number.isNaN(post_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid post id' });
    }

    const post = await prisma.town_hall_post.findFirst({
      where: { post_id, user_id: req.user.user_id },
      select: {
        post_id: true, content: true, created_at: true, is_pinned: true, view_count: true,
        _count: POST_COUNTS,
      },
    });

    // Same shape whether the post doesn't exist or belongs to someone else — don't leak which.
    if (!post) {
      return res.status(404).json({ successful: false, message: 'Post not found' });
    }

    res.json({ successful: true, data: shapePost(post) });
  } catch (err) { next(err); }
});

export default router;
