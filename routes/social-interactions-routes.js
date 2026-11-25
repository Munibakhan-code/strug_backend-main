import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { createNotification } from '../utils/notification-service.js';
import { assertNoSocialProfileBlock } from '../utils/platform-blocks.js';
import { canViewerSeeAuthorPosts } from '../utils/social-visibility.js';

const router = express.Router();

function handleSocialInteractionError(res, err, fallbackMessage = 'Internal server error') {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ successful: false, message: err.message || "This interaction is not available." });
  }
  console.error(err);
  return res.status(500).json({ successful: false, message: fallbackMessage });
}

//======================================================================================================
//========================================= 1. ADVANCED WORKFLOWS =====================================
//======================================================================================================

// Helper to safely get profile_id from authenticated user
async function resolveProfileId(req) {
  if (req.user?.profile_id) return req.user.profile_id;
  if (!req.user?.user_id) return null;
  const sp = await prisma.social_profile.findUnique({
    where: { user_id: req.user.user_id },
    select: { profile_id: true }
  });
  return sp?.profile_id ?? null;
}

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

async function assertPostEngageable(social_post_id, viewerProfileId) {
  const post = await prisma.social_feed.findUnique({
    where: { social_post_id },
    select: { social_post_id: true, profile_id: true, status: true },
  });
  if (!post) return { ok: false, status: 404, message: 'Post not found' };
  if (post.status !== 'published' && post.profile_id !== viewerProfileId) {
    return { ok: false, status: 404, message: 'Post not found' };
  }
  const canSee = await canViewerSeeAuthorPosts(viewerProfileId, post.profile_id);
  if (!canSee) return { ok: false, status: 404, message: 'Post not found' };
  return { ok: true, post };
}

function listPage(req, def = 50, max = 100) {
  const take = Math.min(Math.max(Number(req.query.limit) || def, 1), max);
  const skip = Math.max(Number(req.query.offset) || 0, 0);
  return { take, skip };
}

/**
 * ⚡ TOGGLE LIKE (Reaction)
 */
router.post('/like/:post_id', authenticateToken, async (req, res) => {
  try {
    const social_post_id = parseInt(req.params.post_id);
    const profile_id = await resolveProfileId(req);
    const io = req.app.get('io');

    if (isNaN(social_post_id)) {
      return res.status(400).json({ successful: false, message: "Invalid post_id" });
    }

    if (!profile_id) {
      return res.status(400).json({ successful: false, message: "Social profile setup required" });
    }

    const gate = await assertPostEngageable(social_post_id, profile_id);
    if (!gate.ok) return res.status(gate.status).json({ successful: false, message: gate.message });

    const existing = await prisma.social_interactions.findFirst({
      where: { social_post_id, profile_id, reaction_type: 'like' }
    });

    if (existing) {
      await prisma.social_interactions.delete({ 
        where: { interaction_id: existing.interaction_id } 
      });

      const newCount = await prisma.social_interactions.count({
        where: { social_post_id, reaction_type: 'like' }
      });

      return res.json({ successful: true, action: "unliked", liked: false, newCount });
    } else {
      const post = gate.post;
      await assertNoSocialProfileBlock(profile_id, post.profile_id);

      await prisma.social_interactions.create({
        data: { social_post_id, profile_id, reaction_type: 'like' }
      });

      const newCount = await prisma.social_interactions.count({
        where: { social_post_id, reaction_type: 'like' }
      });

      if (post && post.profile_id !== profile_id) {
        try {
          await createNotification(io, {
            receiver_id: post.profile_id,
            sender_id: profile_id,
            type: 'LIKE',
            target_id: social_post_id
          });
        } catch (notifErr) {
          console.error("⚠️ Socket Notification failure:", notifErr.message);
        }
      }

      return res.json({ successful: true, action: "liked", liked: true, newCount });
    }
  } catch (err) {
    return handleSocialInteractionError(res, err);
  }
});

/**
 * ⚡ TOGGLE BOOKMARK (Save/Unsave Post)
 */
router.post('/bookmark/:post_id', authenticateToken, async (req, res) => {
  try {
    const social_post_id = parseInt(req.params.post_id);
    const profile_id = await resolveProfileId(req);

    if (isNaN(social_post_id)) {
      return res.status(400).json({ successful: false, message: "Invalid post_id" });
    }

    if (!profile_id) {
      return res.status(400).json({ successful: false, message: "Social profile setup required" });
    }

    const gate = await assertPostEngageable(social_post_id, profile_id);
    if (!gate.ok) return res.status(gate.status).json({ successful: false, message: gate.message });

    const existing = await prisma.social_bookmark.findFirst({
      where: { profile_id, social_post_id }
    });

    if (existing) {
      await prisma.social_bookmark.delete({ where: { bookmark_id: existing.bookmark_id } });
      return res.json({ successful: true, saved: false, message: "Removed from bookmarks" });
    } else {
      await assertNoSocialProfileBlock(profile_id, gate.post.profile_id);

      await prisma.social_bookmark.create({
        data: { profile_id, social_post_id }
      });
      return res.json({ successful: true, saved: true, message: "Added to bookmarks" });
    }
  } catch (err) {
    return handleSocialInteractionError(res, err);
  }
});

/**
 * ⚡ GET MY SAVED POSTS
 */
router.get('/bookmarks/me', authenticateToken, async (req, res) => {
    try {
        const profile_id = await resolveProfileId(req);
        if (!profile_id) return res.json({ successful: true, data: [] });
        const bookmarks = await prisma.social_bookmark.findMany({
            where: { profile_id },
            include: { social_post: { include: { social_media_attachments: true, social_profile: true } } },
            orderBy: { created_at: 'desc' }
        });
        res.json({ successful: true, data: bookmarks.map(b => b.social_post) });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

// Alias for older clients that called /bookmarked-posts
router.get('/bookmarked-posts', authenticateToken, async (req, res) => {
    try {
        const profile_id = await resolveProfileId(req);
        if (!profile_id) return res.json({ successful: true, data: [] });
        const bookmarks = await prisma.social_bookmark.findMany({
            where: { profile_id },
            include: { social_post: { include: { social_media_attachments: true, social_profile: true } } },
            orderBy: { created_at: 'desc' }
        });
        res.json({ successful: true, data: bookmarks.map(b => b.social_post) });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * ⚡ GET MY LIKED POSTS — posts the current user has liked (for profile > Likes tab)
 * NOTE: must be declared before GET /:interaction_id, or "liked-posts" is parsed as an id.
 */
router.get('/liked-posts', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user?.profile_id;
        if (!profile_id) return res.json({ successful: true, data: [] });
        const likes = await prisma.social_interactions.findMany({
            where: { profile_id, reaction_type: 'like', social_post_id: { not: null } },
            include: {
                social_feed: {
                    include: {
                        social_media_attachments: true,
                        social_profile: true,
                        _count: { select: { social_comments: true, social_interactions: true } },
                    },
                },
            },
            orderBy: { interaction_id: 'desc' },
        });
        const data = likes
            .map(l => l.social_feed)
            .filter(Boolean)
            .map(p => ({ ...p, liked: true }));
        res.json({ successful: true, data });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * ⚡ SHARE POST — Persists share interaction
 */
router.post('/share/:post_id', authenticateToken, async (req, res) => {
    try {
        const social_post_id = parseInt(req.params.post_id);
        const profile_id = req.user.profile_id;
        
        if (!profile_id) return res.status(400).json({ message: "Profile not found" });

        const gate = await assertPostEngageable(social_post_id, profile_id);
        if (!gate.ok) return res.status(gate.status).json({ successful: false, message: gate.message });

        const existing = await prisma.social_interactions.findFirst({
            where: { social_post_id, profile_id, reaction_type: 'share' }
        });

        if (!existing) {
            await assertNoSocialProfileBlock(profile_id, gate.post.profile_id);

            await prisma.social_interactions.create({
                data: { social_post_id, profile_id, reaction_type: 'share' }
            });
        }

        const count = await prisma.social_interactions.count({
            where: { social_post_id, reaction_type: 'share' }
        });

        return res.json({ successful: true, share_count: count });
    } catch (err) {
        return handleSocialInteractionError(res, err);
    }
});

/* GET ALL SOCIAL INTERACTIONS — admin only (legacy dump) */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { take, skip } = listPage(req);
    const socialInteractions = await prisma.social_interactions.findMany({
      orderBy: { interaction_id: 'desc' },
      take,
      skip,
      include: {
        platform_type: true,
        social_feed: true,
        social_profile: true,
      },
    });

    res.json(socialInteractions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch social interactions' });
  }
});

/* GET INTERACTIONS BY POST ID — must be before /:interaction_id */
router.get('/post/:social_post_id', authenticateToken, async (req, res) => {
  try {
    const social_post_id = Number(req.params.social_post_id);

    if (Number.isNaN(social_post_id)) {
      return res.status(400).json({ error: 'social_post_id must be a number' });
    }

    const post = await prisma.social_feed.findUnique({
      where: { social_post_id },
      select: { profile_id: true, status: true },
    });
    if (!post || post.status !== 'published') {
      return res.status(404).json({ error: 'Post not found' });
    }
    const canSee = await canViewerSeeAuthorPosts(req.user?.profile_id, post.profile_id);
    if (!canSee) return res.status(403).json({ error: 'Forbidden' });

    const { take, skip } = listPage(req);
    const interactions = await prisma.social_interactions.findMany({
      where: { social_post_id },
      take,
      skip,
      select: {
        interaction_id: true,
        reaction_type: true,
        profile_id: true,
      },
    });

    res.json(interactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch interactions for post' });
  }
});

/* GET SOCIAL INTERACTION BY ID */
router.get('/:interaction_id', authenticateToken, async (req, res) => {
  try {
    const interaction_id = Number(req.params.interaction_id);

    if (Number.isNaN(interaction_id)) {
      return res.status(400).json({ error: 'interaction_id must be a number' });
    }

    const socialInteraction = await prisma.social_interactions.findUnique({
      where: { interaction_id },
      include: {
        platform_type: true,
        social_feed: true,
        social_profile: true,
      },
    });

    if (!socialInteraction) {
      return res.status(404).json({ error: 'Social interaction not found' });
    }

    const profile_id = await resolveProfileId(req);
    const owns = socialInteraction.profile_id === profile_id;
    if (!owns && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(socialInteraction);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch social interaction' });
  }
});

/* CREATE SOCIAL INTERACTION — identity always from JWT, never body.user_id.
 * Dedupes by (post, profile, reaction_type) so legacy clients cannot inflate like counts. */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const profile_id = await resolveProfileId(req);
    if (!profile_id) {
      return res.status(400).json({ error: 'Social profile setup required' });
    }

    const { social_post_id, reaction_type, platform_type_id } = req.body;
    const postId = Number(social_post_id);
    const reaction = typeof reaction_type === 'string' ? reaction_type.trim().slice(0, 20) : '';
    if (Number.isNaN(postId) || !reaction) {
      return res.status(400).json({ error: 'social_post_id and reaction_type are required' });
    }

    const existing = await prisma.social_interactions.findFirst({
      where: { social_post_id: postId, profile_id, reaction_type: reaction },
      include: {
        platform_type: true,
        social_feed: true,
        social_profile: true,
      },
    });
    if (existing) {
      return res.status(200).json(existing);
    }

    const post = await prisma.social_feed.findUnique({
      where: { social_post_id: postId },
      select: { profile_id: true, status: true },
    });
    if (!post || post.status !== 'published') {
      return res.status(404).json({ error: 'Post not found' });
    }
    const canSee = await canViewerSeeAuthorPosts(profile_id, post.profile_id);
    if (!canSee) return res.status(403).json({ error: 'Forbidden' });
    await assertNoSocialProfileBlock(profile_id, post.profile_id);

    const socialInteraction = await prisma.social_interactions.create({
      data: {
        social_post_id: postId,
        profile_id,
        reaction_type: reaction,
        platform_type_id: platform_type_id ?? null,
      },
      include: {
        platform_type: true,
        social_feed: true,
        social_profile: true,
      },
    });

    res.status(201).json(socialInteraction);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message || "This interaction is not available." });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create social interaction' });
  }
});

/* UPDATE SOCIAL INTERACTION — owner or admin */
router.put('/:interaction_id', authenticateToken, async (req, res) => {
  try {
    const interaction_id = Number(req.params.interaction_id);

    if (Number.isNaN(interaction_id)) {
      return res.status(400).json({ error: 'interaction_id must be a number' });
    }

    const existing = await prisma.social_interactions.findUnique({
      where: { interaction_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Social interaction not found' });
    }
    const profile_id = await resolveProfileId(req);

    // This route deliberately never reassigns social_post_id / profile_id (see the update
    // below), so the block check runs against the row as it already stands and the caller's
    // JWT identity. It previously read `social_post_id` / `user_id` as bare identifiers —
    // neither was ever destructured from req.body, so every request to this endpoint threw
    // ReferenceError and fell through to the generic 500 below.
    if (existing.social_post_id && profile_id) {
      const post = await prisma.social_feed.findUnique({
        where: { social_post_id: Number(existing.social_post_id) },
        select: { profile_id: true },
      });
      if (post?.profile_id) {
        await assertNoSocialProfileBlock(profile_id, post.profile_id);
      }
    }

    const owns = existing.profile_id === profile_id;
    if (!owns && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { reaction_type, platform_type_id } = req.body;

    const updated = await prisma.social_interactions.update({
      where: { interaction_id },
      data: {
        // Never allow reassignment of social_post_id / profile_id via this legacy path.
        reaction_type: reaction_type ?? existing.reaction_type,
        platform_type_id: platform_type_id ?? existing.platform_type_id,
      },
      include: {
        platform_type: true,
        social_feed: true,
        social_profile: true,
      },
    });

    res.json(updated);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message || "This interaction is not available." });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update social interaction' });
  }
});

/* DELETE SOCIAL INTERACTION — owner or admin */
router.delete('/:interaction_id', authenticateToken, async (req, res) => {
  try {
    const interaction_id = Number(req.params.interaction_id);

    if (Number.isNaN(interaction_id)) {
      return res.status(400).json({ error: 'interaction_id must be a number' });
    }

    const existing = await prisma.social_interactions.findUnique({
      where: { interaction_id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Social interaction not found' });
    }

    const profile_id = await resolveProfileId(req);
    const owns = existing.profile_id === profile_id;
    if (!owns && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.social_interactions.delete({
      where: { interaction_id },
    });

    res.json({ message: 'Social interaction deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete social interaction' });
  }
});

export default router;
