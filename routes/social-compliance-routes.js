// routes/social-compliance-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';

const router = express.Router();

/**
 * 1. DATA EXPORT (Portability)

 * GET /social-compliance/export
 */
/**
 * 1. DATA EXPORT (Portability - Upgraded with Town Hall Coverage)
 * GET /social-compliance/export
 */
router.get('/export', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) {
            return res.status(400).json({ successful: false, message: 'Profile setup required before exporting data.' });
        }

        // Relation name is `social_stories` (not `stories`) on social_profile.
        const allData = await prisma.social_profile.findUnique({
            where: { profile_id },
            include: {
                posts: { include: { social_media_attachments: true } },
                social_stories: true,
                comments: true,
                bookmarks: { include: { social_post: true } },
                followers: true,
                following: true,
                user: {
                    include: {
                        town_hall_posts: true,
                        town_hall_post_likes: true,
                        town_hall_post_save: true,
                    },
                },
            },
        });

        if (!allData) {
            return res.status(404).json({ successful: false, message: 'Profile not found.' });
        }

        await prisma.social_audit_log.create({
            data: {
                profile_id,
                action: 'DATA_EXPORT',
                description: 'User requested full data export including Town Hall footprint',
            },
        }).catch((auditErr) => {
            console.warn('[Compliance Export] audit log skipped:', auditErr?.message || auditErr);
        });

        res.json({ successful: true, export_date: new Date(), data: allData });
    } catch (err) {
        console.error('[Compliance Export Error]:', err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 2. PERMANENT ACCOUNT DELETION (GDPR Compliant)

 * DELETE /social-compliance/terminate
 */
/**
 * 2. PERMANENT ACCOUNT DELETION (GDPR Compliant - Upgraded with Town Hall Cascade Purging)
 * DELETE /social-compliance/terminate
 */
router.delete('/terminate', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        const user_id = req.user.user_id;

        // A. Query traditional social media profile media
        const profileMedia = await prisma.social_profile.findUnique({
            where: { profile_id },
            include: {
                posts: { include: { social_media_attachments: true } },
                social_stories: true,
            },
        });

        // B. Query Town Hall posts to identify associated cloud media assets
        const townHallPosts = await prisma.town_hall_post.findMany({
            where: { user_id },
            select: { post_id: true, media_url: true, hls_url: true, thumbnail_url: true }
        });
        const townHallPostIds = townHallPosts.map(p => p.post_id);
        const TOWNHALL_MEDIA_CONTAINER = process.env.AZURE_TOWNHALL_POSTS_CONTAINER || 'townhall-posts';

        const deleteTasks = [];
        
        // 1. Queue traditional feed attachments for deletion from Azure Storage
        (profileMedia?.posts || []).forEach(post => {
            (post.social_media_attachments || []).forEach(media => {
                deleteTasks.push(deleteAzureBlob(process.env.AZURE_SOCIAL_POSTS_CONTAINER, media.media_url));
            });
        });

        // 2. Queue traditional stories for deletion from Azure Storage
        (profileMedia?.social_stories || []).forEach(story => {
            deleteTasks.push(deleteAzureBlob(process.env.AZURE_SOCIAL_STORIES_CONTAINER, story.media_url));
        });

        // 3. Queue Town Hall photos/videos (same container as /town-hall/upload)
        townHallPosts.forEach(post => {
            if (post.media_url) {
                deleteTasks.push(deleteAzureBlob(TOWNHALL_MEDIA_CONTAINER, post.media_url));
            }
            if (post.hls_url) {
                deleteTasks.push(deleteAzureBlob(TOWNHALL_MEDIA_CONTAINER, post.hls_url));
            }
            if (post.thumbnail_url) {
                deleteTasks.push(deleteAzureBlob(TOWNHALL_MEDIA_CONTAINER, post.thumbnail_url));
            }
        });

        // Execute all cloud media deletions in parallel to protect performance
        await Promise.all(deleteTasks);

        // C. Database Purge: Execute atomic transactional deletes to prevent database constraint locks
        await prisma.$transaction([
            // I. Purge all Town Hall interactions cast BY this terminating user
            prisma.town_hall_post_like.deleteMany({ where: { user_id } }),
            prisma.town_hall_post_save.deleteMany({ where: { user_id } }),
            prisma.town_hall_post_view.deleteMany({ where: { user_id } }),
            prisma.town_hall_repost.deleteMany({ where: { user_id } }),
            prisma.town_hall_poll_vote.deleteMany({ where: { user_id } }),

            // II. Purge all Town Hall interactions cast ON this user's posts by other community members
            prisma.town_hall_post_like.deleteMany({ where: { post_id: { in: townHallPostIds } } }),
            prisma.town_hall_post_save.deleteMany({ where: { post_id: { in: townHallPostIds } } }),
            prisma.town_hall_post_view.deleteMany({ where: { post_id: { in: townHallPostIds } } }),
            prisma.town_hall_repost.deleteMany({ where: { post_id: { in: townHallPostIds } } }),

            // III. Nullify self-referential relations (replies and quotes) pointing to this user's posts
            prisma.town_hall_post.updateMany({
                where: { parent_id: { in: townHallPostIds } },
                data: { parent_id: null }
            }),
            prisma.town_hall_post.updateMany({
                where: { quote_post_id: { in: townHallPostIds } },
                data: { quote_post_id: null }
            }),

            // IV. Delete all Town Hall posts created by this user
            prisma.town_hall_post.deleteMany({ where: { user_id } }),

            // V. Finally, delete the social profile (triggers cascading deletion of feed posts/comments/bookmarks)
            prisma.social_profile.delete({ where: { profile_id } })
        ]);

        res.json({ successful: true, message: "Social profile, Town Hall posts, and all associated data deleted permanently from cloud and database." });
    } catch (err) { 
        console.error('[Compliance Termination Error]:', err);
        res.status(500).json({ successful: false, message: 'Internal server error' }); 
    }
});

/**
 * 3. ACCEPT TERMS & CONDITIONS
 */
router.patch('/accept-terms', authenticateToken, async (req, res) => {
    try {
        await prisma.social_profile.update({
            where: { profile_id: req.user.profile_id },
            data: { accepted_terms: true }
        });
        res.json({ successful: true, message: "Terms accepted." });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;