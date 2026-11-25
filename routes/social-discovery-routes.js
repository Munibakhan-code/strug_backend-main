// routes/social-discovery-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { blockedGraphForUser } from '../utils/platform-blocks.js';
import { getExcludedAuthorProfileIds, notInIds } from '../utils/social-visibility.js';

const router = express.Router();

/**
 * 1. UNIVERSAL SEARCH (Profiles & Hashtags)
 * GET /social-discovery/search?q=query
 */
router.get('/search', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json({ profiles: [], tags: [] });

        prisma.social_search_history.create({
            data: { profile_id: req.user.profile_id, query: q }
        }).catch(err => console.error("Search Log Error:", err));

        const blockedGraph = await blockedGraphForUser(req.user?.user_id);
        const excludedAuthors = await getExcludedAuthorProfileIds(req.user?.profile_id);
        const excludedProfileIds = Array.from(new Set([
            ...(blockedGraph.profileIds || []),
            ...(excludedAuthors || []),
        ].map(Number).filter(Boolean)));

        const profiles = await prisma.social_profile.findMany({
            where: {
                is_shadow_banned: false,
                is_banned: false,
                ...(excludedProfileIds.length ? { profile_id: { notIn: excludedProfileIds } } : {}),
                OR: [
                    { handle: { contains: q, mode: 'insensitive' } },
                    { display_name: { contains: q, mode: 'insensitive' } }
                ]
            },
            take: 10,
            select: {
                profile_id: true,
                user_id: true,
                handle: true,
                display_name: true,
                profile_pic_url: true,
                is_verified: true,
            }
        });

        const tags = await prisma.social_tag.findMany({
            where: { name: { contains: q.replace('#', ''), mode: 'insensitive' } },
            take: 10,
            orderBy: { post_count: 'desc' }
        });

        res.json({ successful: true, data: { profiles, tags } });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 2. GET TRENDING HASHTAGS
 * GET /social-discovery/trending-tags
 */
router.get('/trending-tags', async (req, res) => {
    try {
        const trending = await prisma.social_tag.findMany({
            where: { post_count: { gt: 0 } },
            take: 10,
            orderBy: { post_count: 'desc' }
        });
        res.json({ successful: true, data: trending });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 3. GET POSTS BY HASHTAG
 * GET /social-discovery/tag/:tag_name
 */
router.get('/tag/:tag_name', optionalAuth, async (req, res) => {
    try {
        const { tag_name } = req.params;
        const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { profileIds: [] };
        const viewerProfileId = req.user?.profile_id ?? null;
        const excluded = await getExcludedAuthorProfileIds(viewerProfileId);
        const excludedProfileIds = Array.from(new Set([
            ...(blockedGraph.profileIds || []),
            ...(excluded || []),
        ].map(Number).filter(Boolean)));
        const posts = await prisma.social_feed.findMany({
            where: {
                tags: { some: { name: tag_name.toLowerCase() } },
                status: 'published',
                social_profile: { is_shadow_banned: false, is_banned: false },
                ...notInIds('profile_id', excludedProfileIds),
            },
            include: {
                social_media_attachments: true,
                social_profile: { select: { handle: true, profile_pic_url: true } },
                _count: { select: { social_comments: true, social_interactions: true } }
            },
            orderBy: { created_at: 'desc' }
        });
        res.json({ successful: true, data: posts });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;
