// routes/social-follow-routes.js
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { resolveUniqueHandle } from '../utils/profile-identity.js';
import { FOLLOW_ACCEPTED, FOLLOW_PENDING, toggleFollowEdge, acceptFollowRequest, rejectFollowRequest } from '../utils/social-follow.js';

const router = express.Router();

// PNEW-4: a block in EITHER direction must prevent a follow (and the follow notification),
// otherwise blocking is trivially defeated by re-following.
async function isBlockedBetween(a, b) {
    const block = await prisma.social_block.findFirst({
        where: { OR: [
            { blocker_id: a, blocked_id: b },
            { blocker_id: b, blocked_id: a },
        ] }
    });
    return !!block;
}

// PNEW-5: a private profile's follower/following graph + counts are visible only to the
// owner or to an approved (existing) follower. Returns true if the viewer may see them.
async function canViewGraph(targetProfileId, viewerProfileId) {
    const target = await prisma.social_profile.findUnique({
        where: { profile_id: targetProfileId },
        select: { is_private: true },
    });
    if (!target) return { ok: false, status: 404 };
    if (viewerProfileId && viewerProfileId !== targetProfileId && await isBlockedBetween(viewerProfileId, targetProfileId)) {
        return { ok: false, status: 404 };
    }
    if (!target.is_private) return { ok: true };
    if (!viewerProfileId) return { ok: false, status: 403 };
    if (viewerProfileId === targetProfileId) return { ok: true };
    const rel = await prisma.follower.findUnique({
        where: { follower_id_following_id: { follower_id: viewerProfileId, following_id: targetProfileId } },
        select: { status: true },
    });
    return rel?.status === FOLLOW_ACCEPTED ? { ok: true } : { ok: false, status: 403 };
}

/**
 * 1. FOLLOW / UNFOLLOW TOGGLE
 * POST /social-follow/toggle/:profile_id
 */
router.post('/toggle/:target_profile_id', authenticateToken, async (req, res, next) => {
    try {
        let my_profile_id = req.user?.profile_id;

        if (!my_profile_id && req.user?.user_id) {
        const sp = await prisma.social_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { profile_id: true }
        });
        my_profile_id = sp?.profile_id;
        }
        const target_profile_id = parseInt(req.params.target_profile_id);

        if (!my_profile_id) {
            return res.status(400).json({ successful: false, message: "Please setup your social profile first." });
        }
        if (Number.isNaN(target_profile_id)) {
            return res.status(400).json({ successful: false, message: "Invalid profile id." });
        }


        if (my_profile_id === target_profile_id) {
            return res.status(400).json({ successful: false, message: "You cannot follow yourself." });
        }


        const targetProfile = await prisma.social_profile.findUnique({
            where: { profile_id: target_profile_id }
        });

        if (!targetProfile) {
            return res.status(404).json({ successful: false, message: "Target profile not found." });
        }

        if (await isBlockedBetween(my_profile_id, target_profile_id)) {
            return res.status(403).json({ successful: false, message: "Unable to follow this profile." });
        }


        const io = req.app.get('io');
        const result = await toggleFollowEdge({
            myProfileId: my_profile_id,
            targetProfile,
            io,
        });
        return res.json({ successful: true, ...result });
    } catch (err) {
        next(err);
    }
});

/**
 * 2. FOLLOW / UNFOLLOW TOGGLE BY USER ID
 * POST /social-follow/toggle-by-user/:user_id
 */
router.post('/toggle-by-user/:target_user_id', authenticateToken, async (req, res, next) => {
    try {
        let my_profile_id = req.user.profile_id;
        // Same fallback as /toggle/:profile_id — JWT may omit profile_id even when a social_profile exists.
        if (!my_profile_id && req.user?.user_id) {
            const sp = await prisma.social_profile.findUnique({
                where: { user_id: req.user.user_id },
                select: { profile_id: true },
            });
            my_profile_id = sp?.profile_id ?? null;
            if (my_profile_id) req.user.profile_id = my_profile_id;
        }
        const target_user_id = parseInt(req.params.target_user_id);

        if (!my_profile_id) {
            return res.status(400).json({ successful: false, message: "Please setup your social profile first." });
        }
        if (Number.isNaN(target_user_id)) {
            return res.status(400).json({ successful: false, message: "Invalid user id." });
        }

        const targetProfile = await prisma.social_profile.findUnique({ where: { user_id: target_user_id } });
        let resolvedTarget = targetProfile;
        // Live streamers may not have set up a social profile yet — create a minimal one so
        // Follow from /live still works (notifications + following tab share this graph).
        if (!resolvedTarget) {
            const [user, streamer] = await Promise.all([
                prisma.user.findUnique({ where: { user_id: target_user_id }, select: { user_id: true, name: true, username: true } }),
                prisma.live_streamer_profile.findUnique({ where: { user_id: target_user_id }, select: { handle: true, display_name: true, profile_pic_url: true } }),
            ]);
            if (!user) return res.status(404).json({ successful: false, message: "Target profile not found." });
            const handle = await resolveUniqueHandle(
                String(streamer?.handle || user.username || `user${user.user_id}`),
                target_user_id,
            );
            try {
                resolvedTarget = await prisma.social_profile.create({
                    data: {
                        user_id: target_user_id,
                        handle,
                        display_name: streamer?.display_name || user.name || handle,
                        profile_pic_url: streamer?.profile_pic_url ?? null,
                    },
                });
            } catch (e) {
                if (e?.code === 'P2002') {
                    resolvedTarget = await prisma.social_profile.findUnique({ where: { user_id: target_user_id } });
                } else {
                    throw e;
                }
            }
            if (!resolvedTarget) return res.status(404).json({ successful: false, message: "Target profile not found." });
        }
        if (my_profile_id === resolvedTarget.profile_id) {
            return res.status(400).json({ successful: false, message: "You cannot follow yourself." });
        }
        if (await isBlockedBetween(my_profile_id, resolvedTarget.profile_id)) {
            return res.status(403).json({ successful: false, message: "Unable to follow this profile." });
        }

        const io = req.app.get('io');
        const result = await toggleFollowEdge({
            myProfileId: my_profile_id,
            targetProfile: resolvedTarget,
            io,
        });
        return res.json({ successful: true, ...result });
    } catch (err) {
        next(err);
    }
});

router.post('/requests/:requester_profile_id/accept', authenticateToken, async (req, res, next) => {
    try {
        const ownerId = req.user?.profile_id;
        const requesterId = parseInt(req.params.requester_profile_id, 10);
        if (!ownerId) return res.status(400).json({ successful: false, message: "Please setup your social profile first." });
        if (Number.isNaN(requesterId)) return res.status(400).json({ successful: false, message: "Invalid profile id." });
        const result = await acceptFollowRequest({
            ownerProfileId: ownerId,
            requesterProfileId: requesterId,
            io: req.app.get('io'),
        });
        if (!result.ok) return res.status(result.status).json({ successful: false, message: result.message });
        return res.json({ successful: true, action: 'accepted' });
    } catch (err) {
        next(err);
    }
});

router.post('/requests/:requester_profile_id/reject', authenticateToken, async (req, res, next) => {
    try {
        const ownerId = req.user?.profile_id;
        const requesterId = parseInt(req.params.requester_profile_id, 10);
        if (!ownerId) return res.status(400).json({ successful: false, message: "Please setup your social profile first." });
        if (Number.isNaN(requesterId)) return res.status(400).json({ successful: false, message: "Invalid profile id." });
        const result = await rejectFollowRequest({
            ownerProfileId: ownerId,
            requesterProfileId: requesterId,
        });
        if (!result.ok) return res.status(result.status).json({ successful: false, message: result.message });
        return res.json({ successful: true, action: 'rejected' });
    } catch (err) {
        next(err);
    }
});

/**
 * 2b. AM I FOLLOWING THIS PROFILE? (authoritative single-relationship check)
 * GET /social-follow/is-following/:profile_id
 * Used by the profile page instead of scanning a (capped) followers list.
 */
router.get('/is-following/:profile_id', authenticateToken, async (req, res) => {
    try {
        const my_profile_id = req.user.profile_id;
        const target = parseInt(req.params.profile_id);
        if (Number.isNaN(target)) return res.status(400).json({ successful: false, message: "Invalid profile id." });
        if (!my_profile_id) return res.json({ successful: true, following: false });
        const rel = await prisma.follower.findUnique({
            where: { follower_id_following_id: { follower_id: my_profile_id, following_id: target } },
            select: { status: true },
        });
        res.json({
            successful: true,
            following: rel?.status === FOLLOW_ACCEPTED,
            requested: rel?.status === FOLLOW_PENDING,
        });
    } catch (err) {
        res.status(500).json({ successful: false, message: "Error checking follow status" });
    }
});

/**
 * 2c. AM I FOLLOWING THIS USER? (by user_id — used by live watch / channel pages)
 * GET /social-follow/is-following-by-user/:user_id
 */
router.get('/is-following-by-user/:target_user_id', authenticateToken, async (req, res) => {
    try {
        const my_profile_id = req.user.profile_id;
        const targetUserId = parseInt(req.params.target_user_id, 10);
        if (Number.isNaN(targetUserId)) {
            return res.status(400).json({ successful: false, message: 'Invalid user id.' });
        }
        if (!my_profile_id) return res.json({ successful: true, following: false });
        const targetProfile = await prisma.social_profile.findUnique({
            where: { user_id: targetUserId },
            select: { profile_id: true },
        });
        if (!targetProfile) return res.json({ successful: true, following: false });
        const rel = await prisma.follower.findUnique({
            where: {
                follower_id_following_id: {
                    follower_id: my_profile_id,
                    following_id: targetProfile.profile_id,
                },
            },
            select: { status: true },
        });
        res.json({
            successful: true,
            following: rel?.status === FOLLOW_ACCEPTED,
            requested: rel?.status === FOLLOW_PENDING,
        });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Error checking follow status' });
    }
});

/**
 * 3. GET FOLLOWER/FOLLOWING COUNTS
 * GET /social-follow/counts/:profile_id
 */
router.get('/counts/:profile_id', optionalAuth, async (req, res) => {
    try {
        const profile_id = parseInt(req.params.profile_id);
        if (Number.isNaN(profile_id)) return res.status(400).json({ successful: false, message: "Invalid profile id." });

        const access = await canViewGraph(profile_id, req.user?.profile_id);
        if (!access.ok) return res.status(access.status).json({ successful: false, message: access.status === 404 ? "Profile not found." : "This account is private." });

        const counts = await prisma.social_profile.findUnique({
            where: { profile_id },
            select: {
                _count: {
                    select: {
                        followers: { where: { status: FOLLOW_ACCEPTED } },
                        following: { where: { status: FOLLOW_ACCEPTED } },
                    }
                }
            }
        });

        res.json({ successful: true, data: counts });
    } catch (err) {
        res.status(500).json({ successful: false, message: "Error fetching counts" });
    }
});

// Shared select for the public profile fields returned in follower/following lists
const LIST_PROFILE_SELECT = {
    profile_id: true, user_id: true, handle: true, display_name: true,
    profile_pic_url: true, is_verified: true,
};

/**
 * GET /social-follow/requests — inbound pending follow requests (private profile owner).
 * #1626 / #1189: accept/reject POST routes existed; this is the list those UIs need.
 */
router.get('/requests', authenticateToken, async (req, res, next) => {
    try {
        const ownerId = req.user?.profile_id;
        if (!ownerId) {
            return res.status(400).json({ successful: false, message: 'Please setup your social profile first.' });
        }

        const blocks = await prisma.social_block.findMany({
            where: { OR: [{ blocker_id: ownerId }, { blocked_id: ownerId }] },
            select: { blocker_id: true, blocked_id: true },
        });
        const blockedIds = new Set();
        for (const b of blocks) {
            blockedIds.add(b.blocker_id);
            blockedIds.add(b.blocked_id);
        }
        blockedIds.delete(ownerId);

        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const rows = await prisma.follower.findMany({
            where: {
                following_id: ownerId,
                status: FOLLOW_PENDING,
                ...(blockedIds.size ? { follower_id: { notIn: [...blockedIds] } } : {}),
            },
            include: { follower: { select: LIST_PROFILE_SELECT } },
            orderBy: { created_at: 'desc' },
            take,
        });

        res.json({
            successful: true,
            data: rows
                .filter((r) => r.follower)
                .map((r) => ({
                    requester_profile_id: r.follower_id,
                    requested_at: r.created_at,
                    requester: r.follower,
                })),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * 3b. SUGGESTED USERS TO FOLLOW — "who to follow" discovery
 * GET /social-follow/suggestions?limit=12
 *
 * Previously the feed had no real discovery: the FE built "suggested" lists from authors
 * already present in the feed, so once you followed those people the list ran dry and you
 * could only find new accounts by typing an exact username. (bug report #67)
 * This returns public profiles the caller does NOT already follow, ranked by popularity
 * (follower count), excluding self and anyone blocked in either direction.
 */
router.get('/suggestions', authenticateToken, async (req, res, next) => {
    try {
        const my_profile_id = req.user.profile_id;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);

        const exclude = new Set();
        let myFollowingIds = [];
        if (my_profile_id) {
            exclude.add(my_profile_id);
            const [following, blocks] = await Promise.all([
                prisma.follower.findMany({ where: { follower_id: my_profile_id, status: FOLLOW_ACCEPTED }, select: { following_id: true } }),
                prisma.social_block.findMany({
                    where: { OR: [{ blocker_id: my_profile_id }, { blocked_id: my_profile_id }] },
                    select: { blocker_id: true, blocked_id: true },
                }),
            ]);
            myFollowingIds = following.map(f => f.following_id);
            following.forEach(f => exclude.add(f.following_id));
            blocks.forEach(b => { exclude.add(b.blocker_id); exclude.add(b.blocked_id); });
        }

        const suggestions = await prisma.social_profile.findMany({
            where: {
                profile_id: { notIn: [...exclude] },
                is_private: false,
                is_banned: false,
                is_shadow_banned: false,
            },
            select: { ...LIST_PROFILE_SELECT, _count: { select: { followers: true } } },
            orderBy: { followers: { _count: 'desc' } },
            take: limit,
        });

        // #449: the "N mutuals" line under each suggestion was invented on the client — the count
        // was literally (index % 3) + 1 and the little avatar was some unrelated author from the
        // feed. So a brand-new account with no connections at all was told it had "2 mutuals".
        // Compute the real thing: a mutual of suggestion X is someone I follow who also follows X.
        // One extra query for the whole strip, and we already have my following set above.
        const mutualsBySuggestion = new Map();
        const suggestionIds = suggestions.map(s => s.profile_id);
        if (myFollowingIds.length > 0 && suggestionIds.length > 0) {
            const mutualEdges = await prisma.follower.findMany({
                where: {
                    following_id: { in: suggestionIds },
                    follower_id: { in: myFollowingIds },
                    status: FOLLOW_ACCEPTED,
                },
                select: {
                    following_id: true,
                    follower: { select: LIST_PROFILE_SELECT },
                },
            });
            for (const edge of mutualEdges) {
                const bucket = mutualsBySuggestion.get(edge.following_id) ?? [];
                bucket.push(edge.follower);
                mutualsBySuggestion.set(edge.following_id, bucket);
            }
        }

        res.json({
            successful: true,
            data: suggestions.map(({ _count, ...p }) => {
                const mutuals = mutualsBySuggestion.get(p.profile_id) ?? [];
                return {
                    ...p,
                    follower_count: _count?.followers ?? 0,
                    mutual_count: mutuals.length,
                    // A few real faces for the avatar stack; the client shows nothing when empty.
                    mutuals: mutuals.slice(0, 3),
                };
            }),
        });
    } catch (err) { next(err); }
});

/**
 * 4. LIST FOLLOWERS — profiles that follow :profile_id
 * GET /social-follow/followers/:profile_id
 */
router.get('/followers/:profile_id', optionalAuth, async (req, res) => {
    try {
        const profile_id = parseInt(req.params.profile_id);
        if (Number.isNaN(profile_id)) return res.status(400).json({ successful: false, message: "Invalid profile id." });
        const access = await canViewGraph(profile_id, req.user?.profile_id);
        if (!access.ok) return res.status(access.status).json({ successful: false, message: access.status === 404 ? "Profile not found." : "This account is private." });
        const take = Math.min(parseInt(req.query.limit) || 100, 200);
        const skip = parseInt(req.query.offset) || 0;
        const rows = await prisma.follower.findMany({
            where: { following_id: profile_id, status: FOLLOW_ACCEPTED },
            include: { follower: { select: LIST_PROFILE_SELECT } },
            orderBy: { created_at: 'desc' },
            take, skip,
        });
        res.json({ successful: true, data: rows.map(r => r.follower).filter(Boolean) });
    } catch (err) {
        res.status(500).json({ successful: false, message: "Error fetching followers" });
    }
});

/**
 * 5. LIST FOLLOWING — profiles that :profile_id follows
 * GET /social-follow/following/:profile_id
 */
router.get('/following/:profile_id', optionalAuth, async (req, res) => {
    try {
        const profile_id = parseInt(req.params.profile_id);
        if (Number.isNaN(profile_id)) return res.status(400).json({ successful: false, message: "Invalid profile id." });
        const access = await canViewGraph(profile_id, req.user?.profile_id);
        if (!access.ok) return res.status(access.status).json({ successful: false, message: access.status === 404 ? "Profile not found." : "This account is private." });
        const take = Math.min(parseInt(req.query.limit) || 100, 200);
        const skip = parseInt(req.query.offset) || 0;
        const rows = await prisma.follower.findMany({
            where: { follower_id: profile_id, status: FOLLOW_ACCEPTED },
            include: { following: { select: LIST_PROFILE_SELECT } },
            orderBy: { created_at: 'desc' },
            take, skip,
        });
        res.json({ successful: true, data: rows.map(r => r.following).filter(Boolean) });
    } catch (err) {
        res.status(500).json({ successful: false, message: "Error fetching following" });
    }
});

export default router;
