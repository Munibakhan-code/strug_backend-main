// routes/social-privacy-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
    blockedSocialProfilesForUser,
    closeDirectChatsBetweenUsers,
    createPlatformBlockBetweenUsers,
    deletePlatformBlockBetweenUsers,
    ensureSocialProfileForUser,
    outgoingBlockedGraphForUser,
} from '../utils/platform-blocks.js';
import { acceptPendingInboundOnGoPublic } from '../utils/social-follow.js';

const router = express.Router();

function serializeBlockedAccount(row) {
    const blocked = row?.blocked || {};
    return {
        block_id: row.block_id,
        profile_id: blocked.profile_id,
        user_id: blocked.user_id,
        display_name: blocked.display_name || blocked.handle || 'Blocked account',
        handle: blocked.handle || null,
        profile_pic_url: blocked.profile_pic_url || null,
        blocked_at: row.created_at,
    };
}

router.get('/blocked', authenticateToken, async (req, res) => {
    try {
        const rows = await blockedSocialProfilesForUser(req.user.user_id);
        return res.json({ successful: true, data: rows.map(serializeBlockedAccount) });
    } catch (err) {
        console.error('Failed to load blocked accounts:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 1. BLOCK / UNBLOCK TOGGLE
 * POST /social-privacy/block/:target_id
 */
router.post('/block/:target_id', authenticateToken, async (req, res) => {
    try {
        const myProfile = await ensureSocialProfileForUser(req.user.user_id);
        const my_id = myProfile?.profile_id;
        const target_id = parseInt(req.params.target_id);

        if (!my_id) return res.status(400).json({ message: "Profile setup required." });
        if (Number.isNaN(target_id)) return res.status(400).json({ message: "Invalid target id." });
        if (my_id === target_id) return res.status(400).json({ message: "Cannot block yourself" });

        const targetExists = await prisma.social_profile.findUnique({ where: { profile_id: target_id }, select: { profile_id: true, user_id: true } });
        if (!targetExists) return res.status(404).json({ message: "Target profile not found." });

        const existing = await prisma.social_block.findUnique({
            where: { blocker_id_blocked_id: { blocker_id: my_id, blocked_id: target_id } }
        });
        const outgoingGraph = await outgoingBlockedGraphForUser(req.user.user_id);
        const alreadyBlocked = Boolean(existing)
            || outgoingGraph.userIds.map(Number).includes(Number(targetExists.user_id))
            || outgoingGraph.profileIds.map(Number).includes(Number(target_id));

        if (alreadyBlocked) {
            await deletePlatformBlockBetweenUsers(prisma, req.user.user_id, targetExists.user_id);
            return res.json({ action: "unblocked" });
        } else {

            await createPlatformBlockBetweenUsers(prisma, req.user.user_id, targetExists.user_id);
            if (targetExists?.user_id) {
                await closeDirectChatsBetweenUsers(prisma, req.user.user_id, targetExists.user_id).catch(() => null);
            }
            return res.json({ action: "blocked" });
        }
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

router.delete('/block/:target_id', authenticateToken, async (req, res) => {
    try {
        const myProfile = await ensureSocialProfileForUser(req.user.user_id);
        const my_id = myProfile?.profile_id;
        const target_id = parseInt(req.params.target_id);
        if (!my_id) return res.status(400).json({ message: "Profile setup required." });
        if (Number.isNaN(target_id)) return res.status(400).json({ message: "Invalid target id." });
        const target = await prisma.social_profile.findUnique({
            where: { profile_id: target_id },
            select: { user_id: true },
        });
        if (target?.user_id) {
            await deletePlatformBlockBetweenUsers(prisma, req.user.user_id, target.user_id);
        } else {
            await prisma.social_block.deleteMany({ where: { blocker_id: my_id, blocked_id: target_id } });
        }
        return res.json({ successful: true, action: "unblocked" });
    } catch (err) {
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 2. MUTE / UNMUTE TOGGLE
 * POST /social-privacy/mute/:target_id
 */
router.post('/mute/:target_id', authenticateToken, async (req, res) => {
    try {
        const my_id = req.user.profile_id;
        const target_id = parseInt(req.params.target_id);
        const { posts, story } = req.body;

        if (!my_id) return res.status(400).json({ message: "Profile setup required." });
        if (Number.isNaN(target_id)) return res.status(400).json({ message: "Invalid target id." });
        if (my_id === target_id) return res.status(400).json({ message: "Cannot mute yourself" });

        const targetExists = await prisma.social_profile.findUnique({ where: { profile_id: target_id }, select: { profile_id: true } });
        if (!targetExists) return res.status(404).json({ message: "Target profile not found." });

        const existing = await prisma.social_mute.findUnique({
            where: { muter_id_muted_id: { muter_id: my_id, muted_id: target_id } }
        });

        if (existing) {
            await prisma.social_mute.delete({ where: { mute_id: existing.mute_id } });
            return res.json({ action: "unmuted" });
        } else {
            await prisma.social_mute.create({
                data: { muter_id: my_id, muted_id: target_id, mute_posts: posts, mute_story: story }
            });
            return res.json({ action: "muted" });
        }
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 3. TOGGLE PROFILE PRIVACY (Public/Private)
 * PATCH /social-privacy/settings/privacy
 * #1223: private → public auto-accepts pending inbound follow requests.
 */
router.patch('/settings/privacy', authenticateToken, async (req, res) => {
    try {
        if (!req.user.profile_id) return res.status(400).json({ successful: false, message: "No social profile found." });
        const profile = await prisma.social_profile.findUnique({ where: { profile_id: req.user.profile_id } });
        if (!profile) return res.status(400).json({ successful: false, message: "No social profile found." });
        // Explicit boolean sets the value; omitting it keeps the old toggle behaviour.
        const nextPrivate = typeof req.body?.is_private === 'boolean'
            ? req.body.is_private
            : !profile.is_private;
        const goingPublic = profile.is_private && !nextPrivate;

        const { updated, pendingAccepted } = await prisma.$transaction(async (tx) => {
            const updated = await tx.social_profile.update({
                where: { profile_id: req.user.profile_id },
                data: { is_private: nextPrivate },
            });
            let pendingAccepted = 0;
            if (goingPublic) {
                const result = await acceptPendingInboundOnGoPublic(req.user.profile_id, tx);
                pendingAccepted = result.accepted;
            }
            return { updated, pendingAccepted };
        });

        res.json({
            is_private: updated.is_private,
            ...(goingPublic ? { pending_accepted: pendingAccepted } : {}),
        });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 4. ADD TO CLOSE FRIENDS
 * GET /social-privacy/close-friends — list the viewer's close friends
 * POST /social-privacy/close-friends/:target_id — toggle
 */
router.get('/close-friends', authenticateToken, async (req, res) => {
    try {
        const my_id = req.user.profile_id;
        const my_user_id = req.user.user_id;
        if (!my_id) return res.status(400).json({ successful: false, message: "Profile setup required." });

        const blocks = await prisma.social_block.findMany({
            where: { OR: [{ blocker_id: my_id }, { blocked_id: my_id }] },
            select: { blocker_id: true, blocked_id: true },
        });
        const blockedProfileIds = new Set();
        for (const b of blocks) {
            blockedProfileIds.add(b.blocker_id);
            blockedProfileIds.add(b.blocked_id);
        }
        blockedProfileIds.delete(my_id);

        const outgoingGraph = my_user_id
            ? await outgoingBlockedGraphForUser(my_user_id).catch(() => ({ userIds: [], profileIds: [] }))
            : { userIds: [], profileIds: [] };
        for (const pid of outgoingGraph.profileIds || []) blockedProfileIds.add(Number(pid));
        const blockedUserIds = new Set((outgoingGraph.userIds || []).map(Number));

        const rows = await prisma.close_friend.findMany({
            where: {
                profile_id: my_id,
                ...(blockedProfileIds.size ? { friend_id: { notIn: [...blockedProfileIds] } } : {}),
            },
            include: {
                friend: {
                    select: {
                        profile_id: true,
                        user_id: true,
                        display_name: true,
                        handle: true,
                        profile_pic_url: true,
                    },
                },
            },
            orderBy: { created_at: 'desc' },
            take: 100,
        });

        const data = rows
            .map((row) => row.friend)
            .filter(Boolean)
            .filter((friend) => !blockedUserIds.has(Number(friend.user_id)));

        return res.json({
            successful: true,
            data,
        });
    } catch (err) {
        console.error('Failed to load close friends:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.post('/close-friends/:target_id', authenticateToken, async (req, res) => {
    try {
        const my_id = req.user.profile_id;
        const target_id = parseInt(req.params.target_id);

        if (!my_id) return res.status(400).json({ message: "Profile setup required." });
        if (Number.isNaN(target_id)) return res.status(400).json({ message: "Invalid target id." });
        if (my_id === target_id) return res.status(400).json({ message: "Cannot add yourself" });

        const targetExists = await prisma.social_profile.findUnique({ where: { profile_id: target_id }, select: { profile_id: true } });
        if (!targetExists) return res.status(404).json({ message: "Target profile not found." });

        const existing = await prisma.close_friend.findUnique({
            where: { profile_id_friend_id: { profile_id: my_id, friend_id: target_id } }
        });

        if (existing) {
            await prisma.close_friend.delete({ where: { id: existing.id } });
            return res.json({ action: "removed_from_close_friends" });
        } else {
            await prisma.close_friend.create({ data: { profile_id: my_id, friend_id: target_id } });
            return res.json({ action: "added_to_close_friends" });
        }
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

export default router;
