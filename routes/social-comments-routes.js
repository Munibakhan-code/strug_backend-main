// routes/social-comments-routes.js
import express from "express";
import prisma from "../utils/prisma-client.js";
import { clientErrorMessage } from "../utils/client-error.js";
import { authenticateToken, optionalAuth } from "../middleware/authentication.js";
import { assertNoSocialProfileBlock, blockedGraphForUser } from "../utils/platform-blocks.js";
import { canViewerSeeAuthorPosts } from "../utils/social-visibility.js";

const router = express.Router();

const MAX_COMMENT_LENGTH = 2000;

function handleSocialCommentError(res, err) {
    if (err?.statusCode) {
        return res.status(err.statusCode).json({ successful: false, message: err.message || "This interaction is not available." });
    }
    console.error('POST /social-comment failed:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
}

// The comment card renders the author's display_name and falls back to the handle.
// Both the POST echo and the GET list must carry the same author fields, or a
// just-posted comment renders differently from the same comment after a refetch.
const COMMENT_AUTHOR_SELECT = {
    handle: true,
    display_name: true,
    profile_pic_url: true,
    is_verified: true,
};

async function resolveViewerProfileId(req) {
    if (req.user?.profile_id) return req.user.profile_id;
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return null;
    try {
        const jwt = (await import('jsonwebtoken')).default;
        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
        const viewer = await prisma.social_profile.findFirst({
            where: { user_id: decoded.user_id },
            select: { profile_id: true },
        });
        return viewer?.profile_id ?? null;
    } catch {
        return null;
    }
}

async function assertPostCommentable(social_post_id, viewerProfileId, { requirePublished = true } = {}) {
    const post = await prisma.social_feed.findUnique({
        where: { social_post_id },
        select: { social_post_id: true, profile_id: true, status: true, platform_type_id: true },
    });
    if (!post) return { ok: false, status: 404, message: 'Post not found.' };
    if (requirePublished && post.status !== 'published' && post.profile_id !== viewerProfileId) {
        return { ok: false, status: 404, message: 'Post not found.' };
    }
    const canSee = await canViewerSeeAuthorPosts(viewerProfileId, post.profile_id);
    if (!canSee) return { ok: false, status: 403, message: 'Forbidden' };
    return { ok: true, post };
}

/**
 * 4. POST A COMMENT OR REPLY
 * POST /social-comment/:post_id
 */
router.post('/:post_id', authenticateToken, async (req, res) => {
    try {
        const { text, parent_comment_id, platform_type_id } = req.body;
        const social_post_id = parseInt(req.params.post_id);
        const profile_id = req.user.profile_id;

        if (!profile_id) return res.status(403).json({ message: "Profile is required." });
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ message: "Comment text is required." });
        }
        if (text.length > MAX_COMMENT_LENGTH) {
            return res.status(400).json({ message: `Comment must be at most ${MAX_COMMENT_LENGTH} characters.` });
        }
        if (!Number.isInteger(social_post_id) || social_post_id < 1) {
            return res.status(400).json({ message: "Invalid post id." });
        }

        const gate = await assertPostCommentable(social_post_id, profile_id);
        if (!gate.ok) return res.status(gate.status).json({ message: gate.message });
        await assertNoSocialProfileBlock(profile_id, gate.post.profile_id);

        if (parent_comment_id) {
            const parent = await prisma.social_comments.findUnique({
                where: { comment_id: parseInt(parent_comment_id) },
                select: { social_post_id: true, profile_id: true },
            });
            if (!parent || parent.social_post_id !== social_post_id) {
                return res.status(400).json({ message: "Invalid parent comment." });
            }
            await assertNoSocialProfileBlock(profile_id, parent.profile_id);
        }

        // platform_type_id is optional. Never default to a hard-coded id (e.g. 1) — that
        // FK fails when the seed table has no matching platform_type row. Prefer an explicit
        // client value, otherwise inherit the post's platform, otherwise leave null.
        let resolvedPlatformTypeId = null;
        if (platform_type_id != null && platform_type_id !== '') {
            const parsed = parseInt(platform_type_id, 10);
            if (!Number.isInteger(parsed) || parsed < 1) {
                return res.status(400).json({ message: "Invalid platform_type_id." });
            }
            resolvedPlatformTypeId = parsed;
        } else if (gate.post.platform_type_id != null) {
            resolvedPlatformTypeId = gate.post.platform_type_id;
        }

        const newComment = await prisma.social_comments.create({
            data: {
                social_post_id,
                profile_id,
                text: text.trim(),
                parent_comment_id: parent_comment_id ? parseInt(parent_comment_id) : null,
                timestamp: new Date(),
                platform_type_id: resolvedPlatformTypeId,
            },
            include: { social_profile: { select: COMMENT_AUTHOR_SELECT } }
        });

        res.status(201).json({ successful: true, data: newComment });
    } catch (err) {
        if (err?.code === 'P2003') {
            return res.status(400).json({ successful: false, message: 'Invalid platform_type_id.' });
        }
        return handleSocialCommentError(res, err);
    }
});

/**
 * 5. GET COMMENTS FOR A POST (With Replies)
 * GET /social-comment/:post_id
 */
router.get("/:post_id", optionalAuth, async (req, res) => {
  try {
    const social_post_id = parseInt(req.params.post_id);
    if (!Number.isInteger(social_post_id) || social_post_id <= 0) {
      return res.status(400).json({ successful: false, message: "Invalid post id." });
    }

    const viewerProfileId = await resolveViewerProfileId(req);
    const gate = await assertPostCommentable(social_post_id, viewerProfileId);
    if (!gate.ok) return res.status(gate.status).json({ successful: false, message: gate.message });

    const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { profileIds: [] };
    const blockedProfileIds = blockedGraph.profileIds.map(Number);
    if (gate.post?.profile_id && blockedProfileIds.includes(Number(gate.post.profile_id))) {
        return res.status(404).json({ successful: false, message: "Comments not found." });
    }

    const comments = await prisma.social_comments.findMany({
      where: {
        social_post_id,
        parent_comment_id: null,
        ...(blockedProfileIds.length ? { profile_id: { notIn: blockedProfileIds } } : {}),
      },
      include: {
        social_profile: { select: COMMENT_AUTHOR_SELECT },
        other_social_comments: {
          where: {
            ...(blockedProfileIds.length ? { profile_id: { notIn: blockedProfileIds } } : {}),
          },
          include: {
            social_profile: { select: COMMENT_AUTHOR_SELECT },
          },
        },
      },
      orderBy: { timestamp: "desc" },
    });

    res.json({ successful: true, data: comments });
  } catch (err) {
    res.status(500).json({ error: clientErrorMessage(err) });
  }
});

/**
 * 6. DELETE A COMMENT (Only by owner)
 * DELETE /social-comment/:comment_id
 */
router.delete('/:comment_id', authenticateToken, async (req, res) => {
    try {
        const comment_id = parseInt(req.params.comment_id);
        const profile_id = req.user.profile_id; // Current logged-in user

        // 1. Pehle check karo comment exist karta hai aur kis ka hai
        const existingComment = await prisma.social_comments.findUnique({
            where: { comment_id }
        });

        if (!existingComment) {
            return res.status(404).json({ message: "Comment not found." });
        }

        // 2. Strict Authorization Check
        if (existingComment.profile_id !== profile_id) {
            return res.status(403).json({ message: "Unauthorized! You can only delete your own comments." });
        }

        // 3. Delete the comment
        await prisma.social_comments.delete({ where: { comment_id } });

        res.json({ successful: true, message: "Comment deleted." });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 7. EDIT A COMMENT (Only by owner)
 * PUT /social-comment/:comment_id
 */
router.put('/:comment_id', authenticateToken, async (req, res) => {
    try {
        const comment_id = parseInt(req.params.comment_id);
        const profile_id = req.user.profile_id;
        const { text } = req.body;

        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ message: "Updated text is required." });
        }
        if (text.length > MAX_COMMENT_LENGTH) {
            return res.status(400).json({ message: `Comment must be at most ${MAX_COMMENT_LENGTH} characters.` });
        }

        const existingComment = await prisma.social_comments.findUnique({
            where: { comment_id }
        });

        if (!existingComment) {
            return res.status(404).json({ message: "Comment not found." });
        }

        if (existingComment.profile_id !== profile_id) {
            return res.status(403).json({ message: "Unauthorized! You can only edit your own comments." });
        }

        const updated = await prisma.social_comments.update({
            where: { comment_id },
            data: { text: text.trim() },
            include: { social_profile: { select: COMMENT_AUTHOR_SELECT } }
        });

        res.json({ successful: true, data: updated });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;
