// routes/community-post-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * GET /community-post?community_id=X
 * Returns posts for a community, newest first.
 */
router.get('/', async (req, res, next) => {
    try {
        const community_id = parseInt(req.query.community_id);
        const where = isNaN(community_id) ? { community_id: { not: null } } : { community_id };

        const posts = await prisma.social_feed.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: 50,
            include: {
                social_profile: {
                    select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true }
                },
                _count: { select: { social_comments: true, social_interactions: true } }
            }
        });

        res.json({ successful: true, data: posts });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /community-post/:id
 */
router.get('/:id', async (req, res, next) => {
    try {
        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: parseInt(req.params.id) },
            include: {
                social_profile: {
                    select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true }
                },
                social_comments: { orderBy: { created_at: 'desc' }, take: 50 },
                _count: { select: { social_comments: true, social_interactions: true } }
            }
        });

        if (!post) return res.status(404).json({ successful: false, message: 'Post not found.' });
        res.json({ successful: true, data: post });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /community-post
 * Body: { caption_text, community_id }
 */
router.post('/', authenticateToken, async (req, res, next) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) {
            return res.status(400).json({ successful: false, message: 'Social profile required. Please setup your profile first.' });
        }

        const { caption_text, community_id } = req.body;
        if (!caption_text?.trim()) {
            return res.status(400).json({ successful: false, message: 'Post content is required.' });
        }

        const post = await prisma.social_feed.create({
            data: {
                profile_id,
                caption_text: caption_text.trim(),
                community_id: community_id ? parseInt(community_id) : null,
                status: 'published',
            },
            include: {
                social_profile: {
                    select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true }
                }
            }
        });

        res.status(201).json({ successful: true, data: post });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /community-post/:id
 */
router.delete('/:id', authenticateToken, async (req, res, next) => {
    try {
        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: parseInt(req.params.id) },
            select: { social_post_id: true, profile_id: true }
        });

        if (!post) return res.status(404).json({ successful: false, message: 'Post not found.' });
        if (post.profile_id !== req.user.profile_id) {
            return res.status(403).json({ successful: false, message: 'Not authorized.' });
        }

        await prisma.social_feed.delete({ where: { social_post_id: parseInt(req.params.id) } });
        res.json({ successful: true, message: 'Post deleted.' });
    } catch (err) {
        next(err);
    }
});

export default router;
