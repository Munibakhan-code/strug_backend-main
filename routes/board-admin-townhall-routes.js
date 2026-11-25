// routes/board-admin-townhall-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';

const router = express.Router();

// Apply board authentication and admin capability verification globally to all admin routes
router.use(authenticateBoard, requireDashboard('content-moderation', 'read'));

// Safe helper to purge all Town Hall caches on admin actions (SCAN, not KEYS)
async function purgeTownHallCache() {
    try {
        if (redis && redis.status === 'ready') {
            let cursor = '0';
            let cleared = 0;
            do {
                const [next, keys] = await redis.scan(cursor, 'MATCH', 'townhall:*', 'COUNT', 200);
                cursor = next;
                if (keys?.length) {
                    await redis.del(...keys);
                    cleared += keys.length;
                }
            } while (cursor !== '0');
            if (cleared > 0) {
                console.log(`🧹 [Admin Cache] Purged ${cleared} keys successfully.`);
            }
        }
    } catch (e) {
        console.error('[Admin Cache] Failed to clear:', e.message);
    }
}

// Safe helper to write audit logs to 'social_audit_log' table
async function logAdminAction(adminId, userId, action, description, ipAddress) {
    try {
        const profile = await prisma.social_profile.findUnique({
            where: { user_id: userId },
            select: { profile_id: true }
        });

        if (profile) {
            await prisma.social_audit_log.create({
                data: {
                    admin_id: adminId,
                    profile_id: profile.profile_id,
                    action,
                    description,
                    ip_address: ipAddress || '127.0.0.1'
                }
            });
        }
    } catch (err) {
        console.error('[Audit Log] Failed to write audit record:', err.message);
    }
}

// 1. PATCH /board-admin/townhall/:id/pin — Toggle Global Announcement Pinning
router.patch('/:id/pin', requireDashboard('content-moderation', 'write'), async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid post_id format' });

        const post = await prisma.town_hall_post.findUnique({ where: { post_id } });
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const updated = await prisma.town_hall_post.update({
            where: { post_id },
            data: { is_pinned: !post.is_pinned }
        });

        // Audit Log and Cache Invalidation
        await logAdminAction(
            req.member.member_id,
            post.user_id,
            updated.is_pinned ? 'PIN_POST' : 'UNPIN_POST',
            `Admin ${req.member.name} toggled pin state to ${updated.is_pinned} on Post #${post_id}`,
            req.ip
        );
        await purgeTownHallCache();

        res.json({ successful: true, is_pinned: updated.is_pinned });
    } catch (e) {
        console.error('Admin pin failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 2. PATCH /board-admin/townhall/:id/ban — Toggle Post Ban/Block Status
router.patch('/:id/ban', requireDashboard('content-moderation', 'write'), async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid post_id format' });

        const post = await prisma.town_hall_post.findUnique({ where: { post_id } });
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const updated = await prisma.town_hall_post.update({
            where: { post_id },
            data: { is_banned: !post.is_banned }
        });

        await logAdminAction(
            req.member.member_id,
            post.user_id,
            updated.is_banned ? 'BAN_POST' : 'UNBAN_POST',
            `Admin ${req.member.name} toggled ban state to ${updated.is_banned} on Post #${post_id}`,
            req.ip
        );
        await purgeTownHallCache();

        res.json({ successful: true, is_banned: updated.is_banned });
    } catch (e) {
        console.error('Admin ban failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 3. PATCH /board-admin/townhall/:id/sensitive — Toggle Sensitive Blur Warning Filter
router.patch('/:id/sensitive', requireDashboard('content-moderation', 'write'), async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid post_id format' });

        const post = await prisma.town_hall_post.findUnique({ where: { post_id } });
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const updated = await prisma.town_hall_post.update({
            where: { post_id },
            data: { is_sensitive: !post.is_sensitive }
        });

        await logAdminAction(
            req.member.member_id,
            post.user_id,
            updated.is_sensitive ? 'MARK_SENSITIVE' : 'UNMARK_SENSITIVE',
            `Admin ${req.member.name} toggled sensitive warning to ${updated.is_sensitive} on Post #${post_id}`,
            req.ip
        );
        await purgeTownHallCache();

        res.json({ successful: true, is_sensitive: updated.is_sensitive });
    } catch (e) {
        console.error('Admin sensitive toggle failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 4. POST /board-admin/townhall/user/:user_id/restrict — Restriction: Apply 'RESTRICTED_TOWNHALL' tag to user
router.post('/user/:user_id/restrict', requireDashboard('content-moderation', 'write'), async (req, res) => {
    try {
        const user_id = parseInt(req.params.user_id, 10);
        if (Number.isNaN(user_id)) return res.status(400).json({ message: 'Invalid user_id format' });

        const user = await prisma.user.findUnique({ where: { user_id } });
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Upsert user_tag to ensure safety from double key insertion crashes
        await prisma.user_tag.upsert({
            where: { user_id_tag: { user_id, tag: 'RESTRICTED_TOWNHALL' } },
            update: {},
            create: {
                user_id,
                tag: 'RESTRICTED_TOWNHALL',
                color: '#EF4444', // Danger Red
                created_by_member_id: req.member.member_id,
                created_by_name: req.member.name
            }
        });

        await logAdminAction(
            req.member.member_id,
            user_id,
            'RESTRICT_USER',
            `Admin ${req.member.name} restricted User #${user_id} from posting on Town Hall`,
            req.ip
        );
        await purgeTownHallCache();

        res.json({ successful: true, restricted: true });
    } catch (e) {
        console.error('Admin restrict failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 5. DELETE /board-admin/townhall/user/:user_id/restrict — Lift Restriction: Remove 'RESTRICTED_TOWNHALL' tag
router.delete('/user/:user_id/restrict', requireDashboard('content-moderation', 'write'), async (req, res) => {
    try {
        const user_id = parseInt(req.params.user_id, 10);
        if (Number.isNaN(user_id)) return res.status(400).json({ message: 'Invalid user_id format' });

        const existingTag = await prisma.user_tag.findUnique({
            where: { user_id_tag: { user_id, tag: 'RESTRICTED_TOWNHALL' } }
        });

        if (existingTag) {
            await prisma.user_tag.delete({
                where: { tag_id: existingTag.tag_id }
            });
        }

        await logAdminAction(
            req.member.member_id,
            user_id,
            'UNRESTRICT_USER',
            `Admin ${req.member.name} lifted Town Hall posting restriction on User #${user_id}`,
            req.ip
        );
        await purgeTownHallCache();

        res.json({ successful: true, restricted: false });
    } catch (e) {
        console.error('Admin unrestrict failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default router;