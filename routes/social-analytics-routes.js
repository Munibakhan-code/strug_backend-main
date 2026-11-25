// routes/social-analytics-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * 1. GET DETAILED POST ANALYTICS
 * GET /social-analytics/post/:id
 */
router.get('/post/:id', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const my_profile_id = req.user.profile_id;

        
        const post = await prisma.social_feed.findFirst({
            where: { social_post_id: post_id, profile_id: my_profile_id },
            include: {
                _count: {
                    select: { social_comments: true, social_interactions: true, bookmarks: true, views: true }
                }
            }
        });

        if (!post) return res.status(403).json({ message: "Access denied or post not found." });

        // Engagement Rate = (Likes + Comments + Saves) / Reach * 100
        const totalEngagement = post._count.social_interactions + post._count.social_comments + post._count.bookmarks;
        const reach = post._count.views || 1; 
        const engagementRate = ((totalEngagement / reach) * 100).toFixed(2);

        res.json({
            successful: true,
            data: {
                post_id: post.social_post_id,
                reach: post._count.views,
                likes: post._count.social_interactions,
                comments: post._count.social_comments,
                saves: post._count.bookmarks,
                engagement_rate: `${engagementRate}%`
            }
        });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 2. PROFILE OVERVIEW (Last 30 Days)
 * GET /social-analytics/overview
 */
router.get('/overview', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      
        const stats = await prisma.social_feed.findMany({
            where: { profile_id, created_at: { gte: thirtyDaysAgo } },
            include: {
                // Comments were never counted here, so a new comment could not move any
                // number the overview reports — engagement read as flat no matter what.
                _count: { select: { social_interactions: true, social_comments: true, views: true } }
            }
        });

        const totalReach = stats.reduce((sum, p) => sum + p._count.views, 0);
        const totalLikes = stats.reduce((sum, p) => sum + p._count.social_interactions, 0);
        const totalComments = stats.reduce((sum, p) => sum + p._count.social_comments, 0);

        res.json({
            successful: true,
            period: "Last 30 Days",
            data: {
                total_posts: stats.length,
                total_reach: totalReach,
                total_likes: totalLikes,
                total_comments: totalComments,
            }
        });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 3. TOP PERFORMING POSTS
 * GET /social-analytics/top-posts
 */
router.get('/top-posts', authenticateToken, async (req, res) => {
    try {
        const topPosts = await prisma.social_feed.findMany({
            where: { profile_id: req.user.profile_id },
            orderBy: { social_interactions: { _count: 'desc' } },
            take: 5,
            include: { social_media_attachments: { take: 1 } }
        });
        res.json({ successful: true, data: topPosts });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;