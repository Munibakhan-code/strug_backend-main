// routes/social-profile-routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { checkHandleAvailability, sanitizeHandle } from '../utils/handle-availability.js';
import { recordProfileChange } from '../services/profile-history.js';
import { resolveProfileFallbackData } from '../utils/profile-identity.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';
import { canViewerSeeAuthorPosts } from '../utils/social-visibility.js';
import { z } from 'zod';

const router = express.Router();

// Reject anything that isn't an image at the multer layer (P11 — upload MIME guard).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        cb(new Error('ONLY_IMAGE_UPLOADS'));
    },
});

// Translate the multer fileFilter rejection into a clean 400 instead of a 500.
const handleUpload = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
        if (err) {
            if (err.message === 'ONLY_IMAGE_UPLOADS') return res.status(400).json({ successful: false, message: 'Only image files are allowed.' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ successful: false, message: 'Image must be 5MB or smaller.' });
            return res.status(400).json({ successful: false, message: 'Upload failed.' });
        }
        next();
    });

// Partial update schema (P2) — mirrors the limits in profileSchema for /setup so the
// PATCH route can't blank the display name or store an unbounded bio.
// #436: the opt-in work status shown on the profile. null clears it (the profile then shows no
// badge). Kept here rather than as a DB enum so a new status is a code change, not a migration.
const WORK_STATUSES = ['available_for_work', 'open_to_opportunities', 'hiring'];

function zodIssues(err) {
    return err?.issues ?? err?.errors ?? [];
}

const profileUpdateSchema = z.object({
    // Empty name is "leave unchanged" on a partial PATCH — settings save must not 400
    // just because the name field hasn't loaded yet (or the user left it blank).
    display_name: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v),
        z.string().min(1).max(100).optional(),
    ),
    bio: z.string().max(500).optional(),
    // The settings <select> sends "" for "no badge"; coerce that to null (clear).
    work_status: z.preprocess(
        (v) => (v === '' ? null : v),
        z.enum(WORK_STATUSES).nullable().optional(),
    ),
    show_activity_status: z.boolean().optional(),
});

/**
 * Sanitize a profile row for unauthenticated public reads (P7 — honor moderation/privacy flags).
 * - Banned profiles are not disclosed → returns null (caller sends 404).
 * - Private profiles return a limited card (no bio).
 * - Internal flags (is_private / is_banned) are stripped from the payload either way.
 */
function publicProfileView(profile) {
    if (!profile) return null;
    if (profile.is_banned) return null;
    const { is_banned, is_private, user, ...view } = profile;
    if (is_private) view.bio = null;
    // #423: flatten the referral code onto the profile. A ref code exists to be handed out, so
    // it is public by design — unlike email/address, which stay stripped elsewhere.
    view.ref_code = user?.ref_code ?? null;
    return view;
}

// Validation Schema
const profileSchema = z.object({
    handle: z.string()
        .min(3)
        .max(30)
        .regex(/^[a-zA-Z0-9._]+$/, "Handle can only contain letters, numbers, dots, and underscores")
        .transform(val => val.toLowerCase()),
    display_name: z.string().min(1).max(100),
    bio: z.string().max(500).optional()
});

/**
 * 1. INITIAL SETUP: SOCIAL PROFILE 
 * POST /social-profile/setup
 */
router.post('/setup', authenticateToken, async (req, res, next) => {
    try {
        const validated = profileSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: zodIssues(validated.error) });
        }

        const { display_name, bio } = validated.data;
        const handle = sanitizeHandle(validated.data.handle);
        const user_id = req.user.user_id;

        const existing = await prisma.social_profile.findFirst({
            where: { user_id }
        });

        // A placeholder profile auto-provisioned by an earlier GET /me fallback has
        // handle === `user{id}` and was never customised (username was never synced).
        // Completing setup must UPGRADE that row in place, not reject the user with
        // "you already have a profile" — otherwise every account auto-provisioned during
        // that window is permanently stuck on the setup wizard.
        const isPlaceholder = existing && existing.handle === `user${user_id}`;

        if (existing && !isPlaceholder) {
            return res.status(400).json({
                successful: false,
                message: "You already have a social profile. Use update to change details."
            });
        }

        // Uniqueness is enforced across every handle namespace (social/vertical/streamer/
        // channel/username), not just social_profile, so /@handle stays unambiguous.
        // checkHandleAvailability ignores rows owned by this same user, so the placeholder's
        // own `user{id}` handle never blocks the new handle they're choosing.
        const availability = await checkHandleAvailability(handle, user_id);
        if (!availability.available) {
            return res.status(400).json({ successful: false, message: "This handle is already taken." });
        }

        // Sync handle → user.username so /auth/refresh returns it and the handle works as a
        // referral-code lookup (mirrors PATCH /me/handle behaviour).
        let newProfile;
        try {
            [newProfile] = await prisma.$transaction([
                existing
                    ? prisma.social_profile.update({
                        where: { profile_id: existing.profile_id },
                        data: { handle, display_name, bio },
                    })
                    : prisma.social_profile.create({
                        data: { user_id, handle, display_name, bio }
                    }),
                prisma.user.update({
                    where: { user_id },
                    data: { username: handle },
                }),
            ]);
        } catch (e) {
            // Lost a race against another claimer — the DB unique constraint is the source of truth.
            if (e?.code === 'P2002') {
                return res.status(400).json({ successful: false, message: "This handle is already taken." });
            }
            throw e;
        }

        res.status(201).json({ successful: true, message: "Profile setup complete!", data: newProfile });
    } catch (err) {
        next(err);
    }
});

/**
 * 2. GET MY PROFILE
 * GET /social-profile/me
 */
router.get('/me', authenticateToken, async (req, res, next) => {
    try {
        const profile = await prisma.social_profile.findFirst({
            where: { user_id: req.user.user_id },
            include: { _count: { select: { followers: { where: { status: 'accepted' } }, following: { where: { status: 'accepted' } }, posts: true } } },
        });

        // Do NOT auto-provision a profile here. Return null when there's no profile yet —
        // the client treats it as an empty state and the new-user setup wizard (keyed off
        // the absence of a profile) handles creation. (A 404 here forced the client into
        // an error path; null is the gentler contract every getMyProfile() call site expects.)
        res.json({ successful: true, data: profile || null });
    } catch (err) {
        next(err);
    }
});

// #481/#11: clear the one-time "please re-upload your photo" notice after the user has seen it.
// Idempotent — updateMany so it no-ops (count 0) if there's no profile or the flag is already off.
router.post('/me/dismiss-avatar-notice', authenticateToken, async (req, res, next) => {
    try {
        await prisma.social_profile.updateMany({
            where: { user_id: req.user.user_id, avatar_reset_notice: true },
            data: { avatar_reset_notice: false },
        });
        res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});



/**
 * GET /social-profile/by-handle/:handle — fetch a public profile by handle
 * Used by the /@handle deep-link resolver; returns user_id so the client can
 * load the target profile. Case-insensitive to tolerate mixed-case handles.
 */
router.get('/by-handle/:handle', optionalAuth, async (req, res) => {
    try {
        const handle = String(req.params.handle || '').trim();
        if (!handle) return res.status(400).json({ successful: false, message: 'handle required' });
        const profile = await prisma.social_profile.findFirst({
            where: { handle: { equals: handle, mode: 'insensitive' } },
            select: {
                user_id: true, profile_id: true, handle: true, display_name: true, profile_pic_url: true, banner_url: true, bio: true, is_verified: true,
                created_at: true,
                // #436: the opt-in work-status badge. Without this the profile could never render it —
                // these two selects are what the profile page reads, and they omitted the column.
                work_status: true,
                is_private: true, is_banned: true,
                // #423: the referral code is meant to be shared — surface it on the public
                // profile so anyone can pick it up, not just the owner. Relation is `user`.
                user: { select: { ref_code: true } },
                // #422: which post the owner pinned, so the profile renders their choice
                // instead of guessing at the most-liked one.
                pinned_post_id: true,
                pinned_post_type: true,
                _count: { select: { followers: { where: { status: 'accepted' } }, following: { where: { status: 'accepted' } }, posts: true } },
            },
        });
        if (!profile) return res.status(404).json({ successful: false, message: 'Profile not found' });
        if (req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, profile.user_id)) {
            return res.status(404).json({ successful: false, message: 'Profile not found' });
        }
        const view = publicProfileView(profile);
        if (!view) return res.status(404).json({ successful: false, message: 'Profile not found' });
        res.json({ successful: true, data: view });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * GET /social-profile/by-user/:user_id — fetch a public profile by user_id
 */
router.get('/by-user/:user_id', optionalAuth, async (req, res) => {
    try {
        const user_id = parseInt(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });
        const profile = await prisma.social_profile.findFirst({
            where: { user_id },
            select: {
                profile_id: true, user_id: true, handle: true, display_name: true, profile_pic_url: true, banner_url: true, bio: true, is_verified: true,
                created_at: true,
                // #436: the opt-in work-status badge. Without this the profile could never render it —
                // these two selects are what the profile page reads, and they omitted the column.
                work_status: true,
                is_private: true, is_banned: true,
                // #423: the referral code is meant to be shared — surface it on the public
                // profile so anyone can pick it up, not just the owner. Relation is `user`.
                user: { select: { ref_code: true } },
                // #422: which post the owner pinned, so the profile renders their choice
                // instead of guessing at the most-liked one.
                pinned_post_id: true,
                pinned_post_type: true,
                _count: { select: { followers: { where: { status: 'accepted' } }, following: { where: { status: 'accepted' } }, posts: true } },
            },
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });
        if (req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, profile.user_id)) {
            return res.status(404).json({ message: 'Profile not found' });
        }
        const view = publicProfileView(profile);
        if (!view) return res.status(404).json({ message: 'Profile not found' });
        res.json({ successful: true, data: view });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 3. GET LEAN PROFILE SUMMARY (Optimized for Feed)
 * GET /social-profile/summary/:profile_id
 */
router.get('/summary/:profile_id', optionalAuth, async (req, res) => {
    try {
        const profile_id = parseInt(req.params.profile_id);
        if (Number.isNaN(profile_id)) return res.status(400).json({ successful: false, message: 'profile_id must be a number' });

        // Database
        const summary = await prisma.social_profile.findUnique({
            where: { profile_id },
            select: {
                profile_id: true,
                user_id: true,
                handle: true,
                display_name: true,
                profile_pic_url: true,
                is_verified: true,
                is_private: true,
                is_banned: true,
                user: { select: { ref_code: true } },
                _count: {
                    select: { followers: { where: { status: 'accepted' } }, following: { where: { status: 'accepted' } }, posts: true }
                }
            }
        });

        if (!summary) return res.status(404).json({ message: "Profile not found" });
        if (req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, summary.user_id)) {
            return res.status(404).json({ message: "Profile not found" });
        }
        const view = publicProfileView(summary);
        if (!view) return res.status(404).json({ message: "Profile not found" });

        // Caching Header 
        res.set('Cache-Control', 'public, max-age=300'); 
        res.json({ successful: true, data: view });

    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

/**
 * 4. UPLOAD PROFILE PHOTO
 * PATCH /social-profile/photo
 */
/**
 * 4. UPLOAD PROFILE PHOTO (Resilient Upsert)
 * PATCH /social-profile/photo
 */
router.patch('/photo', authenticateToken, handleUpload('photo'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ successful: false, message: 'No file uploaded.' });

        const user_id = req.user.user_id;
        let profile = await prisma.social_profile.findFirst({ where: { user_id } });

        // Resilience: Auto-provision profile with fallbacks if missing
        if (!profile) {
            const fallback = await resolveProfileFallbackData(prisma, user_id);
            profile = await prisma.social_profile.create({
                data: {
                    user_id,
                    handle: fallback.handle,
                    display_name: fallback.display_name,
                    bio: fallback.bio,
                    banner_url: fallback.banner_url,
                    accepted_terms: false,
                },
                select: { profile_id: true, user_id: true }
            });
        }

        const ext = path.extname(req.file.originalname) || '.jpg';
        const blobName = `profile-${profile.profile_id}-${Date.now()}${ext}`;
        const url = await uploadPublicBlob(
            process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts',
            blobName,
            req.file.buffer,
            req.file.mimetype
        );

        await prisma.social_profile.update({
            where: { profile_id: profile.profile_id },
            data: { profile_pic_url: url },
        });

        res.json({ successful: true, profile_pic_url: url });
    } catch (err) {
        next(err);
    }
});

/**
 * 4b. UPDATE BANNER / COVER PHOTO (Resilient Upsert)
 * PATCH /social-profile/banner
 */
router.patch('/banner', authenticateToken, handleUpload('banner'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ successful: false, message: 'No file uploaded.' });

        const user_id = req.user.user_id;
        let profile = await prisma.social_profile.findFirst({ where: { user_id } });

        // Resilience: Auto-provision profile with fallbacks if missing
        if (!profile) {
            const fallback = await resolveProfileFallbackData(prisma, user_id);
            profile = await prisma.social_profile.create({
                data: {
                    user_id,
                    handle: fallback.handle,
                    display_name: fallback.display_name,
                    bio: fallback.bio,
                    profile_pic_url: fallback.profile_pic_url,
                    accepted_terms: false,
                },
                select: { profile_id: true, user_id: true }
            });
        }

        const ext = path.extname(req.file.originalname) || '.jpg';
        const blobName = `banner-${profile.profile_id}-${Date.now()}${ext}`;
        const url = await uploadPublicBlob(
            process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts',
            blobName,
            req.file.buffer,
            req.file.mimetype
        );

        await prisma.social_profile.update({
            where: { profile_id: profile.profile_id },
            data: { banner_url: url },
        });

        res.json({ successful: true, banner_url: url });
    } catch (err) {
        next(err);
    }
});

/**
 * 5a. UPDATE HANDLE (Resilient Atomic Upsert)
 * PATCH /social-profile/me/handle
 */
router.patch('/me/handle', authenticateToken, async (req, res, next) => {
    try {
        const handleSchema = z.string()
            .min(3).max(30)
            .regex(/^[a-zA-Z0-9._]+$/, "Handle can only contain letters, numbers, dots, and underscores")
            .transform(val => val.toLowerCase());

        const parsed = handleSchema.safeParse(req.body.handle);
        if (!parsed.success) {
            return res.status(400).json({ successful: false, errors: zodIssues(parsed.error) });
        }

        const requestedHandle = parsed.data;
        const user_id = req.user.user_id;

        const availability = await checkHandleAvailability(requestedHandle, user_id);
        if (!availability.available) return res.status(400).json({ successful: false, message: 'This handle is already taken.' });

        let profile = await prisma.social_profile.findFirst({ where: { user_id } });
        let updated;

        if (!profile) {
            // Upsert Creation if profile is missing
            const fallback = await resolveProfileFallbackData(prisma, user_id, { handle: requestedHandle });

            [updated] = await prisma.$transaction([
                prisma.social_profile.create({
                    data: {
                        user_id,
                        handle: fallback.handle,
                        display_name: fallback.display_name,
                        bio: fallback.bio,
                        profile_pic_url: fallback.profile_pic_url,
                        banner_url: fallback.banner_url,
                        accepted_terms: false,
                    },
                    select: { profile_id: true, handle: true, display_name: true, bio: true, profile_pic_url: true, banner_url: true },
                }),
                prisma.user.update({
                    where: { user_id },
                    data: { username: fallback.handle },
                    select: { user_id: true, username: true },
                }),
            ]);
        } else {
            [updated] = await prisma.$transaction([
                prisma.social_profile.update({
                    where: { profile_id: profile.profile_id },
                    data: { handle: requestedHandle },
                    select: { profile_id: true, handle: true, display_name: true, bio: true, profile_pic_url: true, banner_url: true },
                }),
                prisma.user.update({
                    where: { user_id },
                    data: { username: requestedHandle },
                    select: { user_id: true, username: true },
                }),
            ]);
            recordProfileChange(user_id, 'handle', profile.handle, requestedHandle, { changedBy: 'user', actorId: user_id });
        }

        res.json({ successful: true, data: updated });
    } catch (err) {
        if (err?.code === 'P2002') {
            return res.status(400).json({ successful: false, message: 'This handle is already taken.' });
        }
        next(err);
    }
});

/**
 * 5b. UPDATE PROFILE (Resilient Upsert: bio, display_name)
 * PATCH /social-profile/me
 */
router.patch('/me', authenticateToken, async (req, res, next) => {
    try {
        const parsed = profileUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ successful: false, errors: zodIssues(parsed.error) });
        }

        const user_id = req.user.user_id;
        let profile = await prisma.social_profile.findFirst({
            where: { user_id },
            select: { profile_id: true, display_name: true },
        });
        const { bio, display_name, work_status, show_activity_status } = parsed.data;

        let updated;

        if (!profile) {
            // Upsert Creation if profile is missing
            const fallback = await resolveProfileFallbackData(prisma, user_id, { display_name, bio });

            updated = await prisma.social_profile.create({
                data: {
                    user_id,
                    handle: fallback.handle,
                    display_name: fallback.display_name,
                    bio: fallback.bio,
                    profile_pic_url: fallback.profile_pic_url,
                    banner_url: fallback.banner_url,
                    work_status: work_status || null,
                    show_activity_status: show_activity_status !== undefined ? show_activity_status : true,
                    accepted_terms: false,
                },
                select: { profile_id: true, handle: true, display_name: true, bio: true, profile_pic_url: true, banner_url: true, work_status: true, show_activity_status: true },
            });
        } else {
            updated = await prisma.social_profile.update({
                where: { profile_id: profile.profile_id },
                data: {
                    ...(bio !== undefined ? { bio } : {}),
                    ...(display_name !== undefined ? { display_name } : {}),
                    ...(work_status !== undefined ? { work_status } : {}),
                    ...(show_activity_status !== undefined ? { show_activity_status } : {}),
                },
                select: { profile_id: true, handle: true, display_name: true, bio: true, profile_pic_url: true, banner_url: true, work_status: true, show_activity_status: true },
            });

            if (display_name !== undefined) {
                recordProfileChange(user_id, 'display_name', profile.display_name, display_name, { changedBy: 'user', actorId: user_id });
            }
        }

        res.json({ successful: true, data: updated });
    } catch (err) { next(err); }
});


// ── #422: user-selectable pinned post ────────────────────────────────────────────────────
// The profile used to GUESS its "pinned" post client-side (the most-liked one, which on a tie
// is just the latest) — the owner had no say. This stores an explicit choice.
const PIN_TYPES = new Set(['social', 'townhall']);

// Confirm the caller actually owns the post they're pinning, so nobody can pin someone else's.
async function assertOwnsPost(type, postId, user) {
    if (type === 'social') {
        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: postId },
            select: { profile_id: true },
        });
        if (!post) return 'Post not found';
        if (post.profile_id !== user.profile_id) return 'You can only pin your own post';
        return null;
    }
    const post = await prisma.town_hall_post.findUnique({
        where: { post_id: postId },
        select: { user_id: true },
    });
    if (!post) return 'Post not found';
    if (post.user_id !== user.user_id) return 'You can only pin your own post';
    return null;
}

// PATCH /social-profile/me/pinned  { post_id, post_type } — or { post_id: null } to unpin.
router.patch('/me/pinned', authenticateToken, async (req, res) => {
    try {
        const profile = await prisma.social_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { profile_id: true },
        });
        if (!profile) return res.status(404).json({ successful: false, message: 'Profile not found' });

        const raw = req.body?.post_id;
        // Unpin.
        if (raw === null || raw === undefined || raw === '') {
            await prisma.social_profile.update({
                where: { profile_id: profile.profile_id },
                data: { pinned_post_id: null, pinned_post_type: null },
            });
            return res.json({ successful: true, data: { pinned_post_id: null, pinned_post_type: null } });
        }

        const postId = Number(raw);
        if (!Number.isInteger(postId) || postId <= 0) {
            return res.status(400).json({ successful: false, message: 'post_id must be a positive integer' });
        }
        const type = String(req.body?.post_type || 'social');
        if (!PIN_TYPES.has(type)) {
            return res.status(400).json({ successful: false, message: "post_type must be 'social' or 'townhall'" });
        }

        const problem = await assertOwnsPost(type, postId, { ...req.user, profile_id: profile.profile_id });
        if (problem) {
            return res.status(problem === 'Post not found' ? 404 : 403).json({ successful: false, message: problem });
        }

        await prisma.social_profile.update({
            where: { profile_id: profile.profile_id },
            data: { pinned_post_id: postId, pinned_post_type: type },
        });
        return res.json({ successful: true, data: { pinned_post_id: postId, pinned_post_type: type } });
    } catch (err) {
        console.error('pin post error:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

// ── #422: most-viewed item across everything the user has published ──────────────────────
// "This can be a video from the video section, a post from anywhere on the platform etc." — so
// this unions the three content types that each track views in their own way:
//   video           -> views_count counter on the row (user's channel)
//   town_hall_post  -> view_count counter on the row
//   social_feed     -> NO counter column; views are rows in social_post_view, so it's a _count
// and returns the single winner with a type discriminator. Public: it renders on any profile.
router.get('/:user_id/most-viewed', optionalAuth, async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (!Number.isInteger(user_id) || user_id <= 0) {
            return res.status(400).json({ successful: false, message: 'user_id must be a positive integer' });
        }
        const profile = await prisma.social_profile.findUnique({
            where: { user_id },
            select: { profile_id: true, is_private: true, is_banned: true },
        });
        if (profile?.is_banned) {
            return res.status(404).json({ successful: false, message: 'Not found' });
        }
        if (req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, user_id)) {
            return res.status(404).json({ successful: false, message: 'Not found' });
        }
        if (profile) {
            const canSee = await canViewerSeeAuthorPosts(req.user?.profile_id ?? null, profile.profile_id);
            if (!canSee) {
                return res.status(404).json({ successful: false, message: 'Not found' });
            }
        }

        const [topVideo, topTownHall, topSocial] = await Promise.all([
            prisma.video.findFirst({
                // `status` is a MODERATION field ('safe'/'pending_safe'); playability is
                // processing_status ('done'). Filtering on the wrong one silently matches
                // nothing — a video with 48k views was being dropped.
                where: { channel: { user_id }, processing_status: 'done', views_count: { gt: 0 } },
                orderBy: { views_count: 'desc' },
                select: { video_id: true, title: true, thumbnail_url: true, views_count: true },
            }).catch(() => null),
            prisma.town_hall_post.findFirst({
                where: { user_id, is_banned: false, parent_id: null, view_count: { gt: 0 } },
                orderBy: { view_count: 'desc' },
                select: { post_id: true, content: true, media_url: true, media_type: true, view_count: true },
            }).catch(() => null),
            profile
                ? prisma.social_feed.findMany({
                    where: { profile_id: profile.profile_id, status: 'published' },
                    select: {
                        social_post_id: true, caption_text: true,
                        social_media_attachments: { select: { media_url: true }, take: 1 },
                        _count: { select: { post_views: true } },
                    },
                    orderBy: { post_views: { _count: 'desc' } },
                    take: 1,
                }).then((r) => r[0] || null).catch(() => null)
                : null,
        ]);

        const candidates = [];
        if (topVideo) candidates.push({
            type: 'video', id: topVideo.video_id, views: topVideo.views_count,
            text: topVideo.title, image: topVideo.thumbnail_url,
        });
        if (topTownHall) candidates.push({
            type: 'townhall', id: topTownHall.post_id, views: topTownHall.view_count,
            text: topTownHall.content,
            image: topTownHall.media_type === 'image' ? topTownHall.media_url : null,
        });
        if (topSocial && topSocial._count.post_views > 0) candidates.push({
            type: 'social', id: topSocial.social_post_id, views: topSocial._count.post_views,
            text: topSocial.caption_text,
            image: topSocial.social_media_attachments[0]?.media_url ?? null,
        });

        candidates.sort((a, b) => b.views - a.views);
        return res.json({ successful: true, data: candidates[0] ?? null });
    } catch (err) {
        console.error('most-viewed error:', err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;
