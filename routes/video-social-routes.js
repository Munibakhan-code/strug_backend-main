import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { assertNoPlatformBlockBetweenUsers, blockedGraphForUser } from '../utils/platform-blocks.js';

const router = express.Router();

// Engagement is only allowed on a video that exists and isn't banned. Returns null if OK,
// otherwise a { status, message } to send back. Also prevents FK errors (→500) on a
// missing video_id.
async function videoNotEngageable(video_id) {
    const v = await prisma.video.findUnique({
        where: { video_id },
        select: { status: true, channel: { select: { user_id: true } } }
    });
    if (!v || v.status === 'banned') return { status: 404, message: 'Video not found.' };
    return { video: v };
}

/**
 * 1. LIKE / DISLIKE TOGGLE
 * POST /video-social/:video_id/like
 */
router.post('/:video_id/like', authenticateToken, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        if (Number.isNaN(video_id)) return res.status(400).json({ successful: false, message: "Invalid video_id." });
        const user_id = req.user.user_id;
        const { is_like } = req.body;

        if (typeof is_like !== 'boolean') {
            return res.status(400).json({ successful: false, message: "is_like must be a boolean." });
        }

        const engagement = await videoNotEngageable(video_id);
        if (engagement.status) return res.status(engagement.status).json({ successful: false, message: engagement.message });

        const existing = await prisma.video_likes.findUnique({
            where: { user_id_video_id: { user_id, video_id } }
        });

        const willEngage = !existing || existing.is_like !== is_like;
        if (willEngage && engagement.video.channel?.user_id) {
            await assertNoPlatformBlockBetweenUsers(user_id, engagement.video.channel.user_id);
        }

        if (existing) {
            if (existing.is_like === is_like) {
                await prisma.video_likes.delete({ where: { id: existing.id } });
                return res.json({ successful: true, action: "removed" });
            } else {
                const updated = await prisma.video_likes.update({
                    where: { id: existing.id },
                    data: { is_like }
                });
                return res.json({ successful: true, action: "updated", data: updated });
            }
        }

        const newInteraction = await prisma.video_likes.create({
            data: { user_id, video_id, is_like }
        });

        res.json({ successful: true, action: "created", data: newInteraction });
    } catch (err) { next(err); }
});

/**
 * 2. POST A COMMENT OR REPLY
 */
router.post('/:video_id/comment', authenticateToken, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        if (Number.isNaN(video_id)) return res.status(400).json({ successful: false, message: "Invalid video_id." });
        const user_id = req.user.user_id;
        const { content, parent_id } = req.body;

        const trimmed = typeof content === 'string' ? content.trim() : '';
        if (!trimmed) return res.status(400).json({ message: "Content is required." });
        if (trimmed.length > 2000) return res.status(400).json({ message: "Comment must be 2000 characters or fewer." });

        const engagement = await videoNotEngageable(video_id);
        if (engagement.status) return res.status(engagement.status).json({ successful: false, message: engagement.message });
        if (engagement.video.channel?.user_id) {
            await assertNoPlatformBlockBetweenUsers(user_id, engagement.video.channel.user_id);
        }

        // Validate parent_id: must be a positive integer and belong to THIS video — a
        // non-numeric value would otherwise become NaN → Prisma FK error (500), and an
        // unchecked id could attach a reply to another video's comment — see audit L4.
        let parentId = null;
        if (parent_id != null && parent_id !== '') {
            parentId = Number(parent_id);
            if (!Number.isInteger(parentId) || parentId <= 0) {
                return res.status(400).json({ successful: false, message: "Invalid parent_id." });
            }
            const parent = await prisma.video_comments.findUnique({
                where: { comment_id: parentId },
                select: { video_id: true, user_id: true },
            });
            if (!parent || parent.video_id !== video_id) {
                return res.status(400).json({ successful: false, message: "Parent comment does not belong to this video." });
            }
            await assertNoPlatformBlockBetweenUsers(user_id, parent.user_id);
        }

        const comment = await prisma.video_comments.create({
            data: {
                video_id,
                user_id,
                content: trimmed,
                parent_id: parentId
            },
            include: {
                
                user: { select: { name: true } } 
            }
        });

        res.status(201).json({ successful: true, data: comment });
    } catch (err) { next(err); }
});

/**
 * 3. GET VIDEO COMMENTS
 * GET /video-social/:video_id/comments
 */
router.get('/:video_id/comments', optionalAuth, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        if (Number.isNaN(video_id)) return res.status(400).json({ successful: false, message: "Invalid video_id." });

        // VNEW-4: do not serve comments for a banned/removed video.
        const engagement = await videoNotEngageable(video_id);
        if (engagement.status) return res.status(engagement.status).json({ successful: false, message: engagement.message });

        // Paginate top-level comments and batch-load their replies in ONE query. The old
        // shape pulled `video.video_comments` (ALL replies of the video) for EVERY top-level
        // comment — O(top-level × replies) payload, and unbounded (no take/skip). Each comment
        // now carries only its own `replies` array — see audit M2.
        const take = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
        const skip = Math.max(parseInt(req.query.offset) || 0, 0);
        const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { userIds: [] };

        const parents = await prisma.video_comments.findMany({
            where: {
                video_id,
                parent_id: null,
                ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
            },
            include: {
                user: { select: { name: true } },
                _count: { select: { comment_likes: true } },
            },
            orderBy: { created_at: 'desc' },
            take, skip,
        });

        const repliesByParent = new Map();
        if (parents.length > 0) {
            const replies = await prisma.video_comments.findMany({
                where: {
                    video_id,
                    parent_id: { in: parents.map(c => c.comment_id) },
                    ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
                },
                include: {
                    user: { select: { name: true } },
                    _count: { select: { comment_likes: true } },
                },
                orderBy: { created_at: 'asc' },
            });
            for (const r of replies) {
                const arr = repliesByParent.get(r.parent_id) || [];
                arr.push(r);
                repliesByParent.set(r.parent_id, arr);
            }
        }

        const data = parents.map(c => ({ ...c, replies: repliesByParent.get(c.comment_id) || [] }));
        res.json({ successful: true, data });
    } catch (err) { next(err); }
});

/**
 * 4. LIKE / UNLIKE A COMMENT (toggle)
 * POST /video-social/:video_id/comments/:comment_id/like
 */
router.post('/:video_id/comments/:comment_id/like', authenticateToken, async (req, res, next) => {
    try {
        const video_id = Number(req.params.video_id);
        const comment_id = Number(req.params.comment_id);
        if (Number.isNaN(video_id) || Number.isNaN(comment_id)) {
            return res.status(400).json({ successful: false, message: "Invalid video_id or comment_id." });
        }
        const user_id = req.user.user_id;

        // VNEW-3: bind the comment to the path video and reject likes on banned-video comments.
        const comment = await prisma.video_comments.findUnique({
            where: { comment_id },
            select: {
                video_id: true,
                user_id: true,
                video: {
                    select: {
                        status: true,
                        channel: { select: { user_id: true } }
                    }
                }
            }
        });
        if (!comment || comment.video_id !== video_id) {
            return res.status(404).json({ successful: false, message: "Comment not found." });
        }
        if (comment.video.status === 'banned') {
            return res.status(404).json({ successful: false, message: "Video not found." });
        }

        const existing = await prisma.video_comment_likes.findUnique({
            where: { user_id_comment_id: { user_id, comment_id } }
        });

        if (existing) {
            await prisma.video_comment_likes.delete({ where: { id: existing.id } });
            const count = await prisma.video_comment_likes.count({ where: { comment_id } });
            return res.json({ successful: true, liked: false, like_count: count });
        }

        await assertNoPlatformBlockBetweenUsers(user_id, comment.user_id);
        if (comment.video?.channel?.user_id) {
            await assertNoPlatformBlockBetweenUsers(user_id, comment.video.channel.user_id);
        }

        await prisma.video_comment_likes.create({ data: { user_id, comment_id } });
        const count = await prisma.video_comment_likes.count({ where: { comment_id } });
        res.json({ successful: true, liked: true, like_count: count });
    } catch (err) { next(err); }
});

/* GET LIKED VIDEO IDS for current user */
router.get('/liked', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const likes = await prisma.video_likes.findMany({
            where: { user_id, is_like: true },
            select: { video_id: true },
        });
        res.json({ successful: true, video_ids: likes.map(l => l.video_id) });
    } catch (err) { next(err); }
});

export default router;
