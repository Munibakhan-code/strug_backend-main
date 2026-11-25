// routes/vertical-profile-routes.js
//
// Per-vertical display identity (bug #3 — profile bleed). The shared social_profile
// stays the user's MAIN identity (Social, Town Hall, community, DMs). Every vertical
// that has its own "edit profile" (rideshare, food, ecommerce, work, services, hosting,
// …) gets an independent identity here so edits in a seller dashboard never overwrite
// the main profile. Per the product spec each vertical profile is a *fully separate
// identity* (its own handle), but until the user customizes it (is_customized=false)
// every field inherits from the main profile.
import express from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { checkHandleAvailability } from '../utils/handle-availability.js';
import { z } from 'zod';

const router = express.Router();

// A vertical slug: lowercase, starts with a letter, allows -/_; covers the 40+ verticals
// (and any future ones) without a hard-coded whitelist that would need editing per launch.
const verticalSchema = z.string()
    .min(2).max(50)
    .regex(/^[a-z][a-z0-9_-]*$/, 'Invalid vertical');

const handleSchema = z.string()
    .min(3).max(30)
    .regex(/^[a-zA-Z0-9._]+$/, 'Handle can only contain letters, numbers, dots, and underscores')
    .transform(val => val.toLowerCase());

// Empty strings clear a field so it re-inherits from the main profile.
const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const identityUpdateSchema = z.object({
    display_name: z.preprocess(blankToNull, z.string().min(1).max(100).nullable().optional()),
    business_name: z.preprocess(blankToNull, z.string().max(150).nullable().optional()),
    bio: z.preprocess(blankToNull, z.string().max(500).nullable().optional()),
    website: z.preprocess(blankToNull, z.string().max(300).nullable().optional()),
    location: z.preprocess(blankToNull, z.string().max(200).nullable().optional()),
    // Allow clearing storefront media written via /photo|/banner upload (Remove photo).
    profile_pic_url: z.preprocess(blankToNull, z.string().max(1000).nullable().optional()),
    banner_url: z.preprocess(blankToNull, z.string().max(1000).nullable().optional()),
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        cb(new Error('ONLY_IMAGE_UPLOADS'));
    },
});
const handleUpload = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
        if (err) {
            if (err.message === 'ONLY_IMAGE_UPLOADS') return res.status(400).json({ successful: false, message: 'Only image files are allowed.' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ successful: false, message: 'Image must be 5MB or smaller.' });
            return res.status(400).json({ successful: false, message: 'Upload failed.' });
        }
        next();
    });

/**
 * Merge a stored vertical_profile row over the user's main social_profile, per field.
 * Any field the vertical hasn't set inherits the main profile's value ("inherit from
 * main until edited"). business_name / website / location are vertical-only (no main
 * equivalent). This is the single resolver other surfaces (chat, orders) reuse in Phase 2.
 */
export function effectiveVerticalIdentity(vp, sp, vertical) {
    return {
        vertical: vp?.vertical ?? vertical ?? null,
        user_id: vp?.user_id ?? sp?.user_id ?? null,
        handle: vp?.handle ?? sp?.handle ?? null,
        display_name: vp?.display_name ?? sp?.display_name ?? null,
        business_name: vp?.business_name ?? null,
        bio: vp?.bio ?? sp?.bio ?? null,
        profile_pic_url: vp?.profile_pic_url ?? sp?.profile_pic_url ?? null,
        banner_url: vp?.banner_url ?? sp?.banner_url ?? null,
        website: vp?.website ?? null,
        location: vp?.location ?? null,
        is_verified: sp?.is_verified ?? false,
        is_customized: !!vp?.is_customized,
        // expose whether each field is the vertical's own value vs inherited, so the
        // editor can show placeholders correctly.
        has_own: {
            handle: vp?.handle != null,
            display_name: vp?.display_name != null,
            bio: vp?.bio != null,
            profile_pic_url: vp?.profile_pic_url != null,
            banner_url: vp?.banner_url != null,
        },
    };
}

const mainProfileSelect = {
    user_id: true, handle: true, display_name: true, bio: true,
    profile_pic_url: true, banner_url: true, is_verified: true,
};

async function getMainProfile(user_id) {
    return prisma.social_profile.findFirst({ where: { user_id }, select: mainProfileSelect });
}

/**
 * GET /vertical-profile/me/:vertical — the caller's identity for one vertical.
 * Returns the effective (merged) identity plus the raw row + the main profile so the
 * editor can pre-fill and show what is inherited.
 */
router.get('/me/:vertical', authenticateToken, async (req, res, next) => {
    try {
        const vertical = verticalSchema.safeParse(String(req.params.vertical || '').toLowerCase());
        if (!vertical.success) return res.status(400).json({ successful: false, message: 'Invalid vertical' });
        const user_id = req.user.user_id;

        const [vp, sp] = await Promise.all([
            prisma.vertical_profile.findUnique({ where: { user_id_vertical: { user_id, vertical: vertical.data } } }),
            getMainProfile(user_id),
        ]);

        res.json({
            successful: true,
            data: effectiveVerticalIdentity(vp, sp, vertical.data),
            raw: vp,
            main: sp,
        });
    } catch (err) { next(err); }
});

/**
 * PATCH /vertical-profile/me/:vertical — update this vertical's identity fields.
 * First write creates the row (seeding nothing — fields stay null and inherit) and
 * marks it customized.
 */
router.patch('/me/:vertical', authenticateToken, async (req, res, next) => {
    try {
        const vertical = verticalSchema.safeParse(String(req.params.vertical || '').toLowerCase());
        if (!vertical.success) return res.status(400).json({ successful: false, message: 'Invalid vertical' });

        const parsed = identityUpdateSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ successful: false, errors: (parsed.error.issues ?? parsed.error.errors) });

        const user_id = req.user.user_id;
        // Only forward keys the client actually sent (so we don't null untouched fields).
        const data = {};
        for (const k of ['display_name', 'business_name', 'bio', 'website', 'location', 'profile_pic_url', 'banner_url']) {
            if (k in req.body) data[k] = parsed.data[k] ?? null;
        }

        const updated = await prisma.vertical_profile.upsert({
            where: { user_id_vertical: { user_id, vertical: vertical.data } },
            create: { user_id, vertical: vertical.data, is_customized: true, ...data },
            update: { is_customized: true, ...data },
        });

        const sp = await getMainProfile(user_id);
        res.json({ successful: true, data: effectiveVerticalIdentity(updated, sp, vertical.data), raw: updated });
    } catch (err) { next(err); }
});

/**
 * PATCH /vertical-profile/me/:vertical/handle — set this vertical's own (separate) handle.
 * Enforced unique across BOTH vertical_profile and social_profile so /@handle stays
 * unambiguous.
 */
router.patch('/me/:vertical/handle', authenticateToken, async (req, res, next) => {
    try {
        const vertical = verticalSchema.safeParse(String(req.params.vertical || '').toLowerCase());
        if (!vertical.success) return res.status(400).json({ successful: false, message: 'Invalid vertical' });

        const parsed = handleSchema.safeParse(req.body.handle);
        if (!parsed.success) return res.status(400).json({ successful: false, errors: (parsed.error.issues ?? parsed.error.errors) });
        const handle = parsed.data;
        const user_id = req.user.user_id;

        // Unique across every handle namespace, excluding the caller's own rows.
        const availability = await checkHandleAvailability(handle, user_id);
        if (!availability.available) return res.status(400).json({ successful: false, message: 'This handle is already taken.' });

        let updated;
        try {
            updated = await prisma.vertical_profile.upsert({
                where: { user_id_vertical: { user_id, vertical: vertical.data } },
                create: { user_id, vertical: vertical.data, handle, is_customized: true },
                update: { handle, is_customized: true },
            });
        } catch (e) {
            if (e?.code === 'P2002') return res.status(400).json({ successful: false, message: 'This handle is already taken.' });
            throw e;
        }
        res.json({ successful: true, data: { handle: updated.handle } });
    } catch (err) { next(err); }
});

async function uploadVerticalImage(req, res, field) {
    const vertical = verticalSchema.safeParse(String(req.params.vertical || '').toLowerCase());
    if (!vertical.success) return res.status(400).json({ successful: false, message: 'Invalid vertical' });
    if (!req.file) return res.status(400).json({ successful: false, message: 'No file uploaded.' });
    const user_id = req.user.user_id;

    const ext = path.extname(req.file.originalname) || '.jpg';
    const blobName = `vprofile-${field}-${user_id}-${vertical.data}-${Date.now()}${ext}`;
    const url = await uploadPublicBlob(
        process.env.AZURE_SOCIAL_POSTS_CONTAINER,
        blobName,
        req.file.buffer,
        req.file.mimetype,
    );
    const column = field === 'banner' ? 'banner_url' : 'profile_pic_url';
    await prisma.vertical_profile.upsert({
        where: { user_id_vertical: { user_id, vertical: vertical.data } },
        create: { user_id, vertical: vertical.data, is_customized: true, [column]: url },
        update: { is_customized: true, [column]: url },
    });
    return res.json({ successful: true, [column]: url });
}

router.patch('/me/:vertical/photo', authenticateToken, handleUpload('photo'), (req, res, next) =>
    uploadVerticalImage(req, res, 'photo').catch(next));
router.patch('/me/:vertical/banner', authenticateToken, handleUpload('banner'), (req, res, next) =>
    uploadVerticalImage(req, res, 'banner').catch(next));

/**
 * GET /vertical-profile/by-user/:user_id/:vertical — public read of a user's vertical
 * identity (used by role-context surfaces: a hired worker, an assigned driver, a
 * restaurant on an order). Falls back to the main profile per field.
 */
router.get('/by-user/:user_id/:vertical', async (req, res, next) => {
    try {
        const user_id = parseInt(req.params.user_id, 10);
        if (Number.isNaN(user_id)) return res.status(400).json({ successful: false, message: 'user_id must be a number' });
        const vertical = verticalSchema.safeParse(String(req.params.vertical || '').toLowerCase());
        if (!vertical.success) return res.status(400).json({ successful: false, message: 'Invalid vertical' });

        const [vp, sp] = await Promise.all([
            prisma.vertical_profile.findUnique({ where: { user_id_vertical: { user_id, vertical: vertical.data } } }),
            getMainProfile(user_id),
        ]);
        if (!vp && !sp) return res.status(404).json({ successful: false, message: 'Profile not found' });
        res.json({ successful: true, data: effectiveVerticalIdentity(vp, sp, vertical.data) });
    } catch (err) { next(err); }
});

/**
 * GET /vertical-profile/by-handle/:handle — resolve a vertical handle to its identity.
 */
router.get('/by-handle/:handle', async (req, res, next) => {
    try {
        const handle = String(req.params.handle || '').trim().toLowerCase();
        if (!handle) return res.status(400).json({ successful: false, message: 'handle required' });
        const vp = await prisma.vertical_profile.findFirst({ where: { handle } });
        if (!vp) return res.status(404).json({ successful: false, message: 'Profile not found' });
        const sp = await getMainProfile(vp.user_id);
        res.json({ successful: true, data: effectiveVerticalIdentity(vp, sp, vp.vertical) });
    } catch (err) { next(err); }
});

export default router;
