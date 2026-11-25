// routes/social-moderation-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';

const router = express.Router();

// What a user can report. The moderation dashboard groups the queue by this value, so
// anything not listed here is unreportable — which is how the video player's report
// dialog ended up submitting nowhere.
const REPORT_TARGET_TYPES = ['POST', 'COMMENT', 'PROFILE', 'VIDEO', 'TOWN_HALL_POST'];

/**
 * 1. REPORT CONTENT (Post/Comment/Profile/Video)
 * POST /social-moderation/report
 */
router.post('/report', authenticateToken, async (req, res) => {
    try {
        const { target_type, target_id, reason } = req.body;
        const reporter_id = req.user.profile_id;

        if (!reporter_id) return res.status(400).json({ message: "Profile setup required." });
        // VIDEO added: the video player has always shown a report dialog, but the only
        // target types accepted here were POST/COMMENT/PROFILE, so a video report had
        // nowhere to go and the dialog was wired to nothing. The moderation dashboard
        // buckets by target_type, so VIDEO reports now surface as their own group.
        if (!REPORT_TARGET_TYPES.includes(target_type)) {
            return res.status(400).json({ message: `Invalid target type. Expected one of: ${REPORT_TARGET_TYPES.join(', ')}.` });
        }
        // PNEW-3: validate body so bad input is a 400, not a Prisma 500.
        const targetIdNum = Number(target_id);
        if (!Number.isInteger(targetIdNum) || targetIdNum <= 0) {
            return res.status(400).json({ message: "Invalid target id." });
        }
        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
            return res.status(400).json({ message: "A reason (1-1000 chars) is required." });
        }

        const report = await prisma.social_report.create({
            data: { reporter_id, target_type, target_id: targetIdNum, reason: reason.trim() }
        });

        res.status(201).json({ successful: true, message: "Report submitted for review.", report_id: report.report_id });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 2. SUBMIT AN APPEAL (Missing Route Added)
 * POST /social-moderation/appeal
 */
router.post('/appeal', authenticateToken, async (req, res) => {
    try {
        const { target_type, target_id, reason } = req.body;
        const profile_id = req.user.profile_id;

        if (!profile_id) return res.status(400).json({ message: "Profile setup required." });

        // PNEW-2: an appeal must concern content the caller actually owns, otherwise a
        // user could file (and an admin could approve) an un-ban for an arbitrary profile.
        const targetIdNum = Number(target_id);
        if (!['POST', 'COMMENT', 'PROFILE', 'TOWN_HALL_POST'].includes(target_type)) {
            return res.status(400).json({ message: "Invalid target type." });
        }
        if (!Number.isInteger(targetIdNum) || targetIdNum <= 0) {
            return res.status(400).json({ message: "Invalid target id." });
        }
        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2000) {
            return res.status(400).json({ message: "A reason (1-2000 chars) is required." });
        }

        if (target_type === 'PROFILE' && targetIdNum !== profile_id) {
            return res.status(403).json({ successful: false, message: "Forbidden" });
        }
        if (target_type === 'POST') {
            const post = await prisma.social_feed.findFirst({
                where: { social_post_id: targetIdNum, profile_id },
                select: { social_post_id: true },
            });
            if (!post) return res.status(403).json({ successful: false, message: "Forbidden" });
        }
        if (target_type === 'COMMENT') {
            const comment = await prisma.social_comments.findFirst({
                where: { comment_id: targetIdNum, profile_id },
                select: { comment_id: true },
            });
            if (!comment) return res.status(403).json({ successful: false, message: "Forbidden" });
        }
        if (target_type === 'TOWN_HALL_POST') {
            const th = await prisma.town_hall_post.findFirst({
                where: { post_id: targetIdNum, user_id: req.user.user_id },
                select: { post_id: true },
            });
            if (!th) return res.status(403).json({ successful: false, message: "Forbidden" });
        }

        const appeal = await prisma.content_appeal.create({
            data: { profile_id, target_type, target_id: targetIdNum, reason: reason.trim() }
        });

        res.status(201).json({ successful: true, message: "Appeal submitted successfully.", appeal_id: appeal.appeal_id });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

const REPORT_STATUSES = ['pending', 'reviewed', 'resolved', 'dismissed'];
const APPEAL_STATUSES = ['pending', 'approved', 'rejected'];

/**
 * 3. ADMIN ACTION: UPDATE REPORT STATUS
 * PATCH /social-moderation/admin/report/:id
 */
router.patch('/admin/report/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {

        const report_id = parseInt(req.params.id);
        if (Number.isNaN(report_id)) return res.status(400).json({ message: "Invalid report id." });
        const { status } = req.body; // pending, reviewed, resolved, dismissed
        if (!REPORT_STATUSES.includes(String(status || ''))) {
            return res.status(400).json({ message: `status must be one of: ${REPORT_STATUSES.join(', ')}` });
        }

        const updatedReport = await prisma.social_report.update({
            where: { report_id },
            data: { status }
        });

        res.json({ successful: true, message: "Report status updated.", data: updatedReport });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 4. ADMIN ACTION: SHADOW BAN Profile
 * PATCH /social-moderation/admin/shadow-ban/:profile_id
 */
router.patch('/admin/shadow-ban/:profile_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const target_id = parseInt(req.params.profile_id);
        if (Number.isNaN(target_id)) return res.status(400).json({ message: "Invalid profile id." });
        const profile = await prisma.social_profile.findFirst({ where: { profile_id: target_id } });

        if (!profile) return res.status(404).json({ message: "Profile not found." });

        const updated = await prisma.social_profile.update({
            where: { profile_id: target_id },
            data: { is_shadow_banned: !profile.is_shadow_banned }
        });

        res.json({ successful: true, is_shadow_banned: updated.is_shadow_banned });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});


/**
 * 5. ADMIN ACTION: RESOLVE AN APPEAL
 * PATCH /social-moderation/admin/appeal/:id
 */
router.patch('/admin/appeal/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const appeal_id = parseInt(req.params.id);
        if (Number.isNaN(appeal_id)) return res.status(400).json({ message: "Invalid appeal id." });
        const { status, admin_note } = req.body; // approved, rejected
        if (!APPEAL_STATUSES.includes(String(status || ''))) {
            return res.status(400).json({ message: `status must be one of: ${APPEAL_STATUSES.join(', ')}` });
        }

        const result = await prisma.$transaction(async (tx) => {
            const appeal = await tx.content_appeal.update({
                where: { appeal_id },
                data: { status }
            });

           
            if (status === 'approved' && appeal.target_type === 'PROFILE') {
                await tx.social_profile.update({
                    where: { profile_id: appeal.target_id },
                    data: { is_banned: false, is_shadow_banned: false }
                });
            }
            if (status === 'approved' && appeal.target_type === 'POST') {
                await tx.social_feed.updateMany({
                    where: { social_post_id: appeal.target_id },
                    data: { status: 'published', is_sensitive: false },
                });
            }
            if (status === 'approved' && appeal.target_type === 'TOWN_HALL_POST') {
                await tx.town_hall_post.updateMany({
                    where: { post_id: appeal.target_id },
                    data: { is_banned: false },
                });
            }

            return appeal;
        });

        res.json({ successful: true, message: `Appeal ${status} successfully.` });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});


/**
 * 1. GET PENDING MODERATION VIDEOS QUEUE (Paginated)
 * GET /board-admin/moderation/pending-videos?page=1&limit=20
 */
router.get('/pending-videos', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const [total, pendingPosts] = await Promise.all([
            prisma.social_feed.count({ where: { status: 'under_review' } }),
            prisma.social_feed.findMany({
                where: { status: 'under_review' },
                skip,
                take: limit,
                orderBy: { created_at: 'asc' }, // Oldest pending posts first
                include: {
                    social_profile: {
                        select: {
                            profile_id: true,
                            user_id: true,
                            handle: true,
                            display_name: true,
                            profile_pic_url: true,
                        }
                    },
                    social_media_attachments: {
                        orderBy: { sequence_order: 'asc' }
                    }
                }
            })
        ]);

        res.json({
            successful: true,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            },
            data: pendingPosts
        });
    } catch (err) {
        console.error('[Admin Moderation Pending Error]:', err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});


/**
 * 2. APPROVE POST (Set status -> 'published' and Notify User)
 * PATCH /board-admin/moderation/approve/:post_id
 */
router.patch('/approve/:post_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const postId = Number(req.params.post_id);
        if (!Number.isInteger(postId) || postId <= 0) {
            return res.status(400).json({ successful: false, message: 'Invalid post_id' });
        }

        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: postId },
            include: { social_profile: { select: { user_id: true } } }
        });

        if (!post) {
            return res.status(404).json({ successful: false, message: 'Post not found' });
        }

        // 1. Update Post Status to 'published'
        const updatedPost = await prisma.social_feed.update({
            where: { social_post_id: postId },
            data: { status: 'published', is_sensitive: false }
        });

        // 2. Notify the creator that their post has been approved
        if (post.social_profile?.user_id) {
            await prisma.notification.create({
                data: {
                    user_id: post.social_profile.user_id,
                    vertical: 'social',
                    type: 'social.moderation_approved',
                    urgency: 'ambient',
                    title: 'Post Approved! 🎉',
                    body: 'Your video post has been reviewed and approved by our moderation team. It is now live on the feed.',
                    entity_type: 'social_post',
                    entity_id: postId,
                    action_url: `/@${post.social_profile.handle || ''}`,
                }
            }).catch(() => {});
        }

        res.json({
            successful: true,
            message: 'Post approved and published successfully',
            data: updatedPost
        });
    } catch (err) {
        console.error('[Admin Moderation Approve Error]:', err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 3. REJECT POST (Purge Blobs, Delete DB Record, and Notify User)
 * DELETE /board-admin/moderation/reject/:post_id
 */
router.delete('/reject/:post_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const postId = Number(req.params.post_id);
        const { reason } = req.body || {}; // Optional rejection reason from admin

        if (!Number.isInteger(postId) || postId <= 0) {
            return res.status(400).json({ successful: false, message: 'Invalid post_id' });
        }

        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: postId },
            include: {
                social_profile: { select: { user_id: true } },
                social_media_attachments: true
            }
        });

        if (!post) {
            return res.status(404).json({ successful: false, message: 'Post not found' });
        }

        // 1. Send rejection notification to user BEFORE deleting DB record
        if (post.social_profile?.user_id) {
            await prisma.notification.create({
                data: {
                    user_id: post.social_profile.user_id,
                    vertical: 'social',
                    type: 'social.moderation_rejected',
                    urgency: 'actionable',
                    title: 'Post Removed',
                    body: `Your video post was removed after review: ${reason || 'Violation of community safety standards'}.`,
                    entity_type: 'social_post',
                    entity_id: postId,
                }
            }).catch(() => {});
        }

        // 2. Delete cloud media blobs from Azure Storage
        const container = process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts';
        for (const att of post.social_media_attachments) {
            if (att.media_url) {
                await deleteAzureBlob(container, att.media_url).catch(() => {});
            }
        }

        // 3. Database Cascade Transaction Delete
        await prisma.$transaction([
            prisma.social_interactions.deleteMany({ where: { social_post_id: postId } }),
            prisma.social_comments.deleteMany({ where: { social_post_id: postId } }),
            prisma.social_bookmark.deleteMany({ where: { social_post_id: postId } }),
            prisma.social_media_attachments.deleteMany({ where: { social_post_id: postId } }),
            prisma.social_feed.delete({ where: { social_post_id: postId } })
        ]);

        res.json({
            successful: true,
            message: 'Post rejected and purged permanently from storage and database.'
        });
    } catch (err) {
        console.error('[Admin Moderation Reject Error]:', err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});


export default router;