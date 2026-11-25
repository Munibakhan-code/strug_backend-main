import express from 'express';
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import { authenticateToken } from '../middleware/authentication.js';
import { getBlendRecommendations } from '../utils/recommendation-engine.js';
import { selectBestAd, getOrCreateShadowPost } from '../utils/ads-delivery-engine.js';
import { blockedGraphForUser } from '../utils/platform-blocks.js';
import { getExcludedAuthorProfileIds, notInIds } from '../utils/social-visibility.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';

const router = express.Router();

// ============================================================================
// TOP SECTION HELPERS (MUST BE AT THE VERY TOP OF THE FILE)
// ============================================================================
const AUTHOR_PROFILE_SELECT = {
  profile_id: true,
  user_id: true,
  handle: true,
  display_name: true,
  profile_pic_url: true,
  is_verified: true,
};

function formatCaptionPayload(rawCaption, maxChars = 120, maxLines = 3) {
  if (!rawCaption || typeof rawCaption !== 'string') {
    return {
      caption_text: '',
      caption_snippet: '',
      is_long_caption: false,
    };
  }

  const cleanCaption = rawCaption.replace(/\n{3,}/g, '\n\n').trim();
  const lines = cleanCaption.split('\n');

  const isExceedingCharLimit = cleanCaption.length > maxChars;
  const isExceedingLineLimit = lines.length > maxLines;
  const is_long_caption = isExceedingCharLimit || isExceedingLineLimit;

  let caption_snippet = cleanCaption;

  if (is_long_caption) {
    if (isExceedingLineLimit) {
      caption_snippet = lines.slice(0, maxLines).join('\n');
    }
    if (caption_snippet.length > maxChars) {
      caption_snippet = caption_snippet.slice(0, maxChars);
    }
    caption_snippet = caption_snippet.trim() + '...';
  }

  return {
    caption_text: cleanCaption,
    caption_snippet,
    is_long_caption,
  };
}


function computeHotScore(post) {
  const likes = post._count?.social_interactions ?? 0;
  const comments = post._count?.social_comments ?? 0;
  const saves = post._count?.bookmarks ?? 0;

  const engagementScore = (likes * 3) + (comments * 5) + (saves * 2);
  const ageInHours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / (1000 * 60 * 60));
  const gravity = 1.5;
  const baseScore = engagementScore / Math.pow(ageInHours + 2, gravity);

  const varianceFactor = 0.05;
  const randomMultiplier = 1 + (Math.random() - 0.5) * 2 * varianceFactor;

  return baseScore * randomMultiplier;
}

// ============================================================================
// PHASE 1 FIX: 3-TIER HYBRID SOCIAL "FOR YOU" FEED ENGINE (PRODUCTION GRADE)
// ============================================================================
router.get('/home', authenticateToken, async (req, res) => {
  try {
    const my_profile_id = req.user?.profile_id;
    const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;
    const limit = 20;
    const viewer_pid = my_profile_id ?? -1;
    const blockedGraph = await blockedGraphForUser(req.user?.user_id);
    const blockedProfileIds = blockedGraph.profileIds;

    // 1. User Follow කරලා ඉන්න Profiles වල IDs ලබාගැනීම
    const following = my_profile_id
      ? await prisma.follower.findMany({
          where: { follower_id: my_profile_id, status: 'accepted' },
          select: { following_id: true },
        })
      : [];

    const followingIds = following.map(f => f.following_id);
    const excludedAuthorIds = await getExcludedAuthorProfileIds(my_profile_id);
    const excludedProfileIds = Array.from(new Set([
      ...blockedProfileIds,
      ...excludedAuthorIds,
    ].map(Number).filter(Boolean)));

    // Standard Profile Selection for consistency
    const AUTHOR_PROFILE_SELECT = {
      profile_id: true,
      user_id: true,
      handle: true,
      display_name: true,
      profile_pic_url: true,
      is_verified: true,
    };

    const feedInclude = {
      social_profile: { select: AUTHOR_PROFILE_SELECT },
      social_media_attachments: { orderBy: { sequence_order: 'asc' } },
      bookmarks: { where: { profile_id: viewer_pid } },
      social_interactions: { where: { profile_id: viewer_pid, reaction_type: 'like' } },
      _count: { select: { social_comments: true, social_interactions: true, bookmarks: true } },
    };

    // ------------------------------------------------------------------------
    // TIER 1: FOLLOWING CONTENT (~50% Quota = 10 Posts)
    // ------------------------------------------------------------------------
    let tier1Posts = [];
    const tier1Authors = followingIds.filter((id) => !excludedProfileIds.includes(Number(id)));
    if (tier1Authors.length > 0) {
      tier1Posts = await prisma.social_feed.findMany({
        take: 10,
        ...(cursor && { skip: 1, cursor: { social_post_id: cursor } }),
        where: {
          profile_id: { in: tier1Authors },
          status: 'published',
        },
        include: feedInclude,
        orderBy: { social_post_id: 'desc' },
      });
    }

    // Deduplication Set
    const seenPostIds = new Set(tier1Posts.map(p => p.social_post_id));

    // ------------------------------------------------------------------------
    // TIER 2: PERSONALISED RECOMMENDATIONS (~30% Quota = 6 Posts)
    // ------------------------------------------------------------------------
    let tier2Posts = [];
    if (my_profile_id) {
      try {
        const rawRecs = await getBlendRecommendations({
          profileId: my_profile_id,
          userId: req.user?.user_id ?? null,
          count: 8,
        });
        
        // De-duplicate against Tier 1 + hide blocked/muted/private
        tier2Posts = rawRecs
          .filter(p => !blockedProfileIds.includes(Number(p.profile_id ?? p.social_profile?.profile_id)))
          .filter(p => !seenPostIds.has(p.social_post_id || p.id))
          .filter(p => {
            const pid = p.profile_id ?? p.social_profile?.profile_id;
            return pid == null || !excludedAuthorIds.includes(pid);
          })
          .slice(0, 6)
          .map(p => {
            const id = p.social_post_id || p.id;
            seenPostIds.add(id);
            return { ...p, is_recommended: true };
          });
      } catch (e) {
        console.warn('[Feed Engine] Recommendation blend skipped:', e.message);
      }
    }

    // ------------------------------------------------------------------------
    // TIER 3: GLOBAL FRESH & TRENDING DISCOVERY (Remaining Quota + Cold Start)
    // ------------------------------------------------------------------------
    const neededGlobalCount = limit - (tier1Posts.length + tier2Posts.length);
    let tier3Posts = [];

    if (neededGlobalCount > 0) {
      tier3Posts = await prisma.social_feed.findMany({
        take: neededGlobalCount + seenPostIds.size, // Fetch extra for NOT IN safety
        ...(cursor && { skip: 1, cursor: { social_post_id: cursor } }),
        where: {
          status: 'published',
          ...notInIds('profile_id', excludedProfileIds),
          ...(seenPostIds.size > 0 ? { social_post_id: { notIn: Array.from(seenPostIds) } } : {}),
        },
        include: feedInclude,
        orderBy: { social_post_id: 'desc' },
      });

      // Filter duplicates & limit to exact needed quota
      tier3Posts = tier3Posts.filter(p => !seenPostIds.has(p.social_post_id)).slice(0, neededGlobalCount);
      tier3Posts.forEach(p => seenPostIds.add(p.social_post_id));
    }

    // ------------------------------------------------------------------------
    // HYBRID BLENDING & HOT SCORE RANKING
    // ------------------------------------------------------------------------
    const rawHybridPool = [...tier1Posts, ...tier2Posts, ...tier3Posts];
    const activeAd = await selectBestAd(req.adContext).catch(() => null);

    // Rank blended pool using Hot Score
    const rankedPool = rawHybridPool.sort((a, b) => computeHotScore(b) - computeHotScore(a));

    // NEW CODE (With Explicit Root Identity & Deep-link Target):
    let finalFeed = rankedPool.map(post => {
      const firstAttachment = post.social_media_attachments?.[0] ?? null;
      const captionPayload = formatCaptionPayload(post.caption_text);
      const rawHandle = post.social_profile?.handle ?? "creator";
      const cleanHandle = rawHandle.replace(/^@/, '');

      return {
        ...post,
        id: post.social_post_id,
        social_post_id: post.social_post_id,
        author_profile_id: post.social_profile?.profile_id ?? post.profile_id,
        author_user_id: post.social_profile?.user_id ?? null,
        profile_id: post.social_profile?.profile_id ?? post.profile_id,
        user_id: post.social_profile?.user_id ?? null,
        mediaUrl: firstAttachment?.media_url ?? null,
        media_url: firstAttachment?.media_url ?? null,
        target_profile_path: `/@${cleanHandle}`,
        is_ad: false,
        liked: post.social_interactions?.length > 0,
        saved: post.bookmarks?.length > 0,
        ...captionPayload,
        _score: parseFloat(computeHotScore(post).toFixed(4)),
      };
    });

    // ------------------------------------------------------------------------
    // AD/SPONSOR CARD INJECTION AT OFFSETS (5, 12, 19)
    // ------------------------------------------------------------------------
    if (activeAd && finalFeed.length > 5) {
      const shadowPostId = await getOrCreateShadowPost(activeAd.campaign_id, activeAd.advertiser_id, activeAd.headline || activeAd.title);
      if (shadowPostId) {
        const adCard = {
          social_post_id: shadowPostId,
          id: shadowPostId,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          saved: false,
          liked: false,
          caption_text: activeAd.description || activeAd.title,
          media_url: activeAd.media_url,
          mediaUrl: activeAd.media_url,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || "LEARN_MORE",
          social_profile: {
            handle: "Sponsored",
            display_name: activeAd.headline || activeAd.title,
            profile_pic_url: null,
            is_verified: true,
          },
          _count: { social_comments: 0, social_interactions: 0, bookmarks: 0 }
        };

        const adOffsets = [5, 12, 19];
        adOffsets.forEach((offset, idx) => {
          if (finalFeed.length > offset) {
            finalFeed.splice(offset, 0, {
              ...adCard,
              social_post_id: shadowPostId,
              id: shadowPostId,
              feed_item_key: `ad:${activeAd.campaign_id}:${idx}`,
            });
          }
        });
      }
    }

    // Next Cursor Calculation for Infinite Scroll.
    // The tier queries paginate by `social_post_id` desc, so the cursor MUST be the
    // smallest DB-backed id fetched this page — NOT the last element of rawHybridPool,
    // which `.sort()` reordered in place by hot score (an arbitrary id → duplicated and
    // skipped posts on scroll). Tier-2 recommendations are injected, not paginated, so
    // they must not drive the cursor.
    const dbPosts = [...tier1Posts, ...tier3Posts];
    const nextCursor = dbPosts.length
      ? dbPosts.reduce((min, p) => (p.social_post_id < min ? p.social_post_id : min), dbPosts[0].social_post_id)
      : null;

    res.json({ successful: true, data: finalFeed, nextCursor });

  } catch (err) {
    console.error("❌ Hybrid Feed Engine Error:", err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

router.post('/seen', authenticateToken, async (req, res) => {
  try {
    const { post_ids } = req.body;
    const profile_id   = req.user.profile_id;

    if (!post_ids || !Array.isArray(post_ids)) {
      return res.status(400).json({ message: 'Post IDs array required' });
    }

    await prisma.social_seen_post.createMany({
      data:           post_ids.map(id => ({ profile_id, post_id: parseInt(id) })),
      skipDuplicates: true,
    });

    res.json({ successful: true });
  } catch (err) { 
    res.status(500).json({ successful: false, message: 'Internal server error' }); 
  }
});

router.get('/explore', authenticateToken, async (req, res) => {
  try {
    const my_profile_id = req.user.profile_id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;

    // profile_id is null until social profile setup — Prisma rejects null on this non-nullable
    // column, so guard the follower lookup and strip nulls from the exclusion list below.
    const following = my_profile_id
      ? await prisma.follower.findMany({
          where:  { follower_id: my_profile_id, status: 'accepted' },
          select: { following_id: true },
        })
      : [];

    const followingIds = following.map(f => f.following_id);
    const blockedGraph = await blockedGraphForUser(req.user?.user_id);
    const excludedAuthors = await getExcludedAuthorProfileIds(my_profile_id);
    const excludeIds = Array.from(new Set([
      my_profile_id,
      ...followingIds,
      ...(blockedGraph.profileIds || []),
      ...(excludedAuthors || []),
    ].filter(id => id != null).map(Number)));

    const explorePosts = await prisma.social_feed.findMany({
      take:  limit,
      ...(cursor && { skip: 1, cursor: { social_post_id: cursor } }),
      where: {
        ...(excludeIds.length ? { profile_id: { notIn: excludeIds } } : {}),
        status:     'published',
      },
      include: {
        social_media_attachments: { orderBy: { sequence_order: 'asc' } },
        social_profile: {
          select: {
            handle:          true,
            display_name:    true,
            profile_pic_url: true,
            is_verified:     true,
            user_id:         true,
          },
        },
        _count: {
          select: {
            social_comments:     true,
            social_interactions: true,
          },
        },
      },
      orderBy: { social_post_id: 'desc' },
    });


    // NEW CODE (With Explicit Root Identity):
    const ranked = [...explorePosts]
      .sort((a, b) => computeHotScore(b) - computeHotScore(a))
      .map(post => {
        const rawHandle = post.social_profile?.handle ?? "creator";
        const cleanHandle = rawHandle.replace(/^@/, '');

        return {
          ...post,
          id: post.social_post_id,
          social_post_id: post.social_post_id,
          author_profile_id: post.social_profile?.profile_id ?? post.profile_id,
          author_user_id: post.social_profile?.user_id ?? null,
          profile_id: post.social_profile?.profile_id ?? post.profile_id,
          user_id: post.social_profile?.user_id ?? null,
          mediaUrl: post.social_media_attachments?.[0]?.media_url ?? null,
          target_profile_path: `/@${cleanHandle}`,
          is_ad: false,
          liked: false,
          saved: false,
          ...formatCaptionPayload(post.caption_text),
        };
      });

    const nextCursor = explorePosts.length === limit ? explorePosts[explorePosts.length - 1].social_post_id : null;

    res.json({ successful: true, data: ranked, nextCursor });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

router.post('/view/:post_id', authenticateToken, async (req, res) => {
  try {
    const post_id    = parseInt(req.params.post_id);
    const profile_id = req.user.profile_id;

    const post = await prisma.social_feed.findUnique({
      where: { social_post_id: post_id },
    });

    if (!post || post.profile_id === profile_id) {
      return res.json({ skip: true });
    }

    await prisma.social_post_view.upsert({
      where:  { post_id_profile_id: { post_id, profile_id } },
      update: {},
      create: { post_id, profile_id },
    });

    res.json({ successful: true });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const post_id    = parseInt(req.params.id);
    const profile_id = req.user.profile_id;

    const existing = await prisma.social_feed.findUnique({
      where:  { social_post_id: post_id },
      select: { profile_id: true, social_media_attachments: { select: { media_url: true } } },
    });

    if (!existing)                            return res.status(404).json({ error: 'Post not found' });
    if (existing.profile_id !== profile_id)   return res.status(403).json({ error: 'Not authorized' });

    for (const attachment of existing.social_media_attachments || []) {
      if (attachment.media_url) {
        await deleteAzureBlob(process.env.AZURE_SOCIAL_POSTS_CONTAINER, attachment.media_url);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.social_interactions.deleteMany({ where: { social_post_id: post_id } });
      await tx.social_comments.deleteMany(    { where: { social_post_id: post_id } });
      await tx.social_bookmark.deleteMany(    { where: { social_post_id: post_id } });
      await tx.social_media_attachments.deleteMany({ where: { social_post_id: post_id } });
      await tx.behance_contacted.deleteMany(  { where: { social_post_id: post_id } });
      await tx.social_feed.delete({ where: { social_post_id: post_id } });
    });

    res.json({ successful: true, message: 'Post deleted' });
  } catch (err) {
    console.error('❌ Delete Error:', err);
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const post_id    = parseInt(req.params.id);
    const profile_id = req.user.profile_id;
    const { caption_text } = req.body;

    if (!caption_text?.trim()) {
      return res.status(400).json({ error: 'caption_text is required' });
    }

    const existing = await prisma.social_feed.findUnique({
      where:  { social_post_id: post_id },
      select: { profile_id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (existing.profile_id !== profile_id) {
      return res.status(403).json({ error: 'Not authorized to edit this post' });
    }

    const updated = await prisma.social_feed.update({
      where: { social_post_id: post_id },
      data:  {
        caption_text: caption_text.trim(),
        updated_at:   new Date(),
      },
    });

    res.json({ successful: true, data: updated });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

// ============================================================================
// FIX: FAIL-SAFE GET /video-feed ROUTE
// ============================================================================
router.get('/video-feed', authenticateToken, async (req, res) => {
  try {
    const my_profile_id = req.user?.profile_id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const viewer_pid = my_profile_id ?? -1;
    const blockedGraph = await blockedGraphForUser(req.user?.user_id);

    const excludedAuthors = await getExcludedAuthorProfileIds(my_profile_id);
    const excludedProfileIds = Array.from(new Set([
      ...(blockedGraph.profileIds || []),
      ...(excludedAuthors || []),
    ].map(Number).filter(Boolean)));

    const videoPosts = await prisma.social_feed.findMany({
      take: limit,
      ...(cursor && { skip: 1, cursor: { social_post_id: cursor } }),
      where: { 
        status: 'published',
        ...notInIds('profile_id', excludedProfileIds),
        social_media_attachments: { some: { media_type: 'video' } } 
      },
      include: {
        social_profile: { select: AUTHOR_PROFILE_SELECT },
        social_media_attachments: { where: { media_type: 'video' }, orderBy: { sequence_order: 'asc' } },
        _count: { select: { social_comments: true, social_interactions: true } },
        social_interactions: {
          where: { profile_id: viewer_pid, reaction_type: 'like' }
        }
      },
      orderBy: { social_post_id: 'desc' }
    });

    const formatted = videoPosts.map(p => {
      const rawHandle = p.social_profile?.handle ?? "creator";
      const cleanHandle = rawHandle.replace(/^@/, '');
      const firstVideo = p.social_media_attachments?.[0]?.media_url ?? "";

      return {
        ...p,
        id: p.social_post_id,
        social_post_id: p.social_post_id,

        // Explicit Root Identity Fields
        author_profile_id: p.social_profile?.profile_id ?? p.profile_id,
        author_user_id: p.social_profile?.user_id ?? null,
        profile_id: p.social_profile?.profile_id ?? p.profile_id,
        user_id: p.social_profile?.user_id ?? null,

        videoUrl: firstVideo,
        mediaUrl: firstVideo,
        media_url: firstVideo,
        user: p.social_profile?.display_name ?? "Creator",
        handle: `@${cleanHandle}`,
        target_profile_path: `/@${cleanHandle}`,

        liked: p.social_interactions && Array.isArray(p.social_interactions) ? p.social_interactions.length > 0 : false,
        likes: p._count?.social_interactions ?? 0,
        ...formatCaptionPayload(p.caption_text),
      };
    });

    const nextCursor = videoPosts.length === limit ? videoPosts[videoPosts.length - 1].social_post_id : null;

    res.json({ successful: true, data: formatted, nextCursor });
  } catch (err) {
    console.error("❌ GET /video-feed Error:", err);
    res.status(500).json({ successful: false, message: 'Internal server error', error: err.message });
  }
});

export default router;
