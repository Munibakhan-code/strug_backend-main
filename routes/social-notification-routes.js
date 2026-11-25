// routes/social-notification-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { enrichChatNotifications } from '../utils/enrich-chat-notifications.js';
import { blockedGraphForUser } from '../utils/platform-blocks.js';

const router = express.Router();

/**
 * 1. GET ALL NOTIFICATIONS (Paginated)
 * GET /social-notification?page=1&limit=20
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        if (!profile_id) return res.status(400).json({ message: "Profile not found" });
        const blockedGraph = await blockedGraphForUser(req.user?.user_id);

        const rows = await prisma.social_notification.findMany({
            where: {
                receiver_id: profile_id,
                ...(blockedGraph.profileIds.length ? { sender_id: { notIn: blockedGraph.profileIds } } : {}),
            },
            skip,
            take: limit,
            include: {
                sender: {
                    select: { profile_id: true, handle: true, profile_pic_url: true, is_verified: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const notifications = await enrichChatNotifications(rows);

        const unreadCount = await prisma.social_notification.count({
            where: {
                receiver_id: profile_id,
                is_read: false,
                ...(blockedGraph.profileIds.length ? { sender_id: { notIn: blockedGraph.profileIds } } : {}),
            }
        });

        res.json({ successful: true, data: notifications, unreadCount });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 2. MARK NOTIFICATION AS READ
 * PATCH /social-notification/read/:id
 */
router.patch('/read/:id', authenticateToken, async (req, res) => {
    try {
        const notification_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;

        await prisma.social_notification.updateMany({
            where: { notification_id, receiver_id: profile_id },
            data: { is_read: true }
        });

        res.json({ successful: true });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 3. MARK ALL AS READ
 * PATCH /social-notification/read-all
 */
router.patch('/read-all', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        await prisma.social_notification.updateMany({
            where: { receiver_id: profile_id, is_read: false },
            data: { is_read: true }
        });
        res.json({ successful: true, message: "All marked as read" });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 4. DELETE A NOTIFICATION
 * DELETE /social-notification/:id
 */
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const notification_id = parseInt(req.params.id);
        await prisma.social_notification.deleteMany({
            where: { notification_id, receiver_id: req.user.profile_id }
        });
        res.json({ successful: true, message: "Notification removed" });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;
