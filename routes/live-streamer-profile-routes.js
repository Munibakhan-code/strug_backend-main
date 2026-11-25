import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { uploadVideoStream } from '../utils/azure-storage.js';
import { checkStreamerHandleAvailability } from '../utils/handle-availability.js';
import { resolveLiveCategoryId } from '../services/live-category-resolver.js';
import { catalogMetaForName } from '../data/live-category-catalog.js';
import { resolveRangeParam, resolveRange, RANGE_DAYS, buildDateBuckets, dayKey, pctChange, round2 } from '../utils/analytics-buckets.js';
import { countSocialFollowersForUserId } from '../utils/social-follow-counts.js';

const router = express.Router();

// Reject non-image uploads at the multer layer (parity with social/vertical profile routes).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        cb(new Error('ONLY_IMAGE_UPLOADS'));
    },
});

// Translate multer rejections into clean 400s instead of a 500 from the error handler.
const handleUpload = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
        if (err) {
            if (err.message === 'ONLY_IMAGE_UPLOADS') return res.status(400).json({ successful: false, message: 'Only image files are allowed.' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ successful: false, message: 'Image must be 5MB or smaller.' });
            return res.status(400).json({ successful: false, message: 'Upload failed.' });
        }
        next();
    });

const streamerProfileSchema = z.object({
    handle: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
    display_name: z.string().min(2).max(100),
    description: z.string().max(1000).optional(),
    category_id: z.number().int().positive()
});

const customizationSchema = z.object({
    theme_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    is_nsfw: z.boolean().optional(),
    stream_delay_ms: z.number().int().min(0).max(60000).optional(),
    social_links: z.array(z.object({
        platform: z.string().min(2).max(50),
        url: z.string().url()
    })).max(5).optional()
});


router.get('/categories', async (req, res, next) => {
    try {
        const categories = await prisma.live_stream_category.findMany({
            where: { is_active: true },
            orderBy: { category_name: 'asc' },
        });
        const sorted = [...categories].sort((a, b) => {
            const aFeat = catalogMetaForName(a.category_name)?.featured ? 0 : 1;
            const bFeat = catalogMetaForName(b.category_name)?.featured ? 0 : 1;
            if (aFeat !== bFeat) return aFeat - bFeat;
            return a.category_name.localeCompare(b.category_name);
        });
        return res.json({ successful: true, data: sorted });
    } catch (err) {
        next(err);
    }
});

// Find or create a category by id or typed name (streamer go-live / setup).
router.post('/categories/resolve', authenticateToken, async (req, res, next) => {
    try {
        const category_id = req.body?.category_id != null ? Number(req.body.category_id) : undefined;
        const category_name = req.body?.category_name;
        const resolvedId = await resolveLiveCategoryId({ category_id, category_name });
        if (!resolvedId) {
            return res.status(400).json({ successful: false, message: 'Invalid_Category' });
        }
        const category = await prisma.live_stream_category.findUnique({
            where: { category_id: resolvedId },
        });
        return res.json({ successful: true, data: category });
    } catch (err) {
        next(err);
    }
});

router.post('/setup', authenticateToken, async (req, res, next) => {
    try {
        const validated = streamerProfileSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const { handle, display_name, description, category_id } = validated.data;
        const user_id = req.user.user_id;
        const normalizedHandle = handle.toLowerCase();

        const existingProfile = await prisma.live_streamer_profile.findUnique({
            where: { user_id }
        });

        if (existingProfile) {
            return res.status(409).json({ successful: false, message: "Streamer_Profile_Exists" });
        }

        // #360 (Option B): a streamer tag is its own namespace — unique among streamers only.
        // It may reuse a handle that exists as a channel/social/vertical/username elsewhere
        // (streams live at /live/@handle, separate from /c/handle), so a creator can stream under
        // their own identity handle even if another account holds that string as a channel.
        const availability = await checkStreamerHandleAvailability(normalizedHandle, user_id);
        if (!availability.available) {
            return res.status(409).json({ successful: false, message: "Handle_Taken" });
        }

        const categoryExists = await prisma.live_stream_category.findUnique({
            where: { category_id }
        });

        if (!categoryExists) {
            return res.status(404).json({ successful: false, message: "Category_Not_Found" });
        }

        let newProfile;
        try {
            newProfile = await prisma.live_streamer_profile.create({
                data: {
                    user_id,
                    category_id,
                    handle: normalizedHandle,
                    display_name,
                    description,
                    sub_wallet: {
                        create: {
                            user_id: user_id
                        }
                    }
                },
                include: {
                    category: true,
                    sub_wallet: true
                }
            });
        } catch (e) {
            if (e?.code === 'P2002') return res.status(409).json({ successful: false, message: "Handle_Taken" });
            throw e;
        }

        return res.status(201).json({ successful: true, data: newProfile });
    } catch (err) {
        next(err);
    }
});

router.get('/me', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            include: {
                category: true,
                social_links: true,
                sub_wallet: true
            }
        });

        if (!profile) {
            // Not having a streamer profile yet is an expected state for any
            // non-streamer — return an empty 200 so the client renders the
            // "Set Up Your Channel" form without a 404 polluting the browser
            // console / error tracking on every dashboard load.
            return res.json({ successful: true, data: null });
        }

        const follower_count = await countSocialFollowersForUserId(user_id);
        const viewsAgg = await prisma.live_vod.aggregate({
            where: { streamer_id: profile.streamer_id },
            _sum: { view_count: true },
        });
        const total_views = viewsAgg._sum.view_count ?? 0;
        return res.json({ successful: true, data: { ...profile, follower_count, total_views } });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /live-streamer/me/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * LIVE-streaming-scoped analytics for the streamer's own dashboard (#147). The existing
 * "Analytics" tab reads the video `channel` system, so a pure live streamer (no uploaded
 * videos) saw nothing. This aggregates the LIVE side: broadcast activity (live_session) +
 * subscription earnings (live_subscription_payment), returned in the shared
 * SellerAnalyticsPanel shape (summary / timeseries / breakdown / top).
 *
 * - count  = live broadcasts that actually went live in the range (started_at set)
 * - gross  = gross subscription revenue (amount_cents/100)
 * - net    = creator's share after the platform split (creator_share)
 * - breakdown = subscribers by status (sub health)
 * - top    = top supporters by lifetime creator earnings
 * Extra summary fields (active_subscribers / air_time_hours / vod_count) surface activity
 * the panel doesn't chart. Scoped to the caller's streamer profile; empty 200 if none.
 */
router.get('/me/analytics/overview', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            select: { streamer_id: true },
        });

        const rangeParam = resolveRangeParam(req.query.range);
        const days = RANGE_DAYS[rangeParam];
        const { start, prevStart, prevEnd } = resolveRange(days);
        const emptySummary = { gross: 0, gross_change_pct: 0, net: 0, net_change_pct: 0, count: 0, count_change_pct: 0, avg_order_value: 0, active_subscribers: 0, air_time_hours: 0, vod_count: 0 };
        const buckets = buildDateBuckets(start, days);
        const emptyTs = buckets.map(date => ({ date, gross: 0, net: 0, count: 0 }));

        if (!profile) {
            return res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary: emptySummary, timeseries: emptyTs, breakdown: [], top: [] } });
        }
        const streamer_id = profile.streamer_id;

        const [sessions, prevSessions, payments, prevPayments, subs, vodCount] = await Promise.all([
            prisma.live_session.findMany({ where: { streamer_id, started_at: { gte: start } }, select: { started_at: true, ended_at: true } }),
            prisma.live_session.findMany({ where: { streamer_id, started_at: { gte: prevStart, lte: prevEnd } }, select: { session_id: true } }),
            prisma.live_subscription_payment.findMany({ where: { streamer_id, created_at: { gte: start } }, select: { amount_cents: true, creator_share: true, created_at: true, subscriber_user_id: true } }),
            prisma.live_subscription_payment.findMany({ where: { streamer_id, created_at: { gte: prevStart, lte: prevEnd } }, select: { amount_cents: true, creator_share: true } }),
            prisma.live_subscription.findMany({ where: { streamer_id }, select: { status: true } }),
            prisma.live_vod.count({ where: { streamer_id, created_at: { gte: start } } }),
        ]);

        // daily buckets: broadcasts (count) + subscription revenue (gross/net)
        const idx = new Map(buckets.map((d, i) => [d, i]));
        const tsGross = new Array(buckets.length).fill(0);
        const tsNet = new Array(buckets.length).fill(0);
        const tsCount = new Array(buckets.length).fill(0);
        for (const p of payments) {
            const i = idx.get(dayKey(p.created_at));
            if (i == null) continue;
            tsGross[i] += (p.amount_cents || 0) / 100;
            tsNet[i] += Number(p.creator_share || 0);
        }
        for (const s of sessions) {
            if (!s.started_at) continue;
            const i = idx.get(dayKey(s.started_at));
            if (i != null) tsCount[i] += 1;
        }
        const timeseries = buckets.map((date, i) => ({ date, gross: round2(tsGross[i]), net: round2(tsNet[i]), count: tsCount[i] }));

        const sumGross = payments.reduce((s, p) => s + (p.amount_cents || 0) / 100, 0);
        const sumNet = payments.reduce((s, p) => s + Number(p.creator_share || 0), 0);
        const prevGross = prevPayments.reduce((s, p) => s + (p.amount_cents || 0) / 100, 0);
        const prevNet = prevPayments.reduce((s, p) => s + Number(p.creator_share || 0), 0);
        const count = sessions.length;
        const airTimeHours = sessions.reduce((s, x) => s + (x.started_at && x.ended_at ? Math.max(0, (new Date(x.ended_at) - new Date(x.started_at)) / 3.6e6) : 0), 0);

        const summary = {
            gross: round2(sumGross),
            gross_change_pct: pctChange(round2(sumGross), round2(prevGross)),
            net: round2(sumNet),
            net_change_pct: pctChange(round2(sumNet), round2(prevNet)),
            count,
            count_change_pct: pctChange(count, prevSessions.length),
            avg_order_value: count > 0 ? round2(sumGross / count) : 0,
            active_subscribers: subs.filter(s => s.status === 'active').length,
            air_time_hours: round2(airTimeHours),
            vod_count: vodCount,
        };

        // breakdown: subscribers by status
        const statusMap = new Map();
        subs.forEach(s => { const k = s.status || 'unknown'; statusMap.set(k, (statusMap.get(k) || 0) + 1); });
        const breakdown = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

        // top supporters by creator earnings — resolve usernames in a guarded query
        const bySupporter = new Map();
        for (const p of payments) {
            if (p.subscriber_user_id == null) continue;
            const e = bySupporter.get(p.subscriber_user_id) || { id: p.subscriber_user_id, net: 0, count: 0 };
            e.net += Number(p.creator_share || 0);
            e.count += 1;
            bySupporter.set(p.subscriber_user_id, e);
        }
        const supporterIds = [...bySupporter.keys()];
        const nameById = new Map();
        if (supporterIds.length) {
            try {
                const users = await prisma.user.findMany({ where: { user_id: { in: supporterIds } }, select: { user_id: true, username: true } });
                users.forEach(u => nameById.set(u.user_id, u.username));
            } catch (e) { /* fall back to "Supporter" */ }
        }
        const top = [...bySupporter.values()]
            .map(e => ({ id: e.id, title: nameById.get(e.id) || 'Supporter', subtitle: `${e.count} payment${e.count === 1 ? '' : 's'}`, gross: round2(e.net), net: round2(e.net), count: e.count }))
            .sort((a, b) => b.net - a.net)
            .slice(0, 8);

        return res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top } });
    } catch (err) {
        next(err);
    }
});

router.patch('/customize', authenticateToken, async (req, res, next) => {
    try {
        const validated = customizationSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const user_id = req.user.user_id;
        const { theme_color, is_nsfw, stream_delay_ms, social_links } = validated.data;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            select: { streamer_id: true }
        });

        if (!profile) {
            return res.status(404).json({ successful: false, message: "Streamer_Profile_Not_Found" });
        }

        const updatedProfile = await prisma.$transaction(async (tx) => {
            const updated = await tx.live_streamer_profile.update({
                where: { streamer_id: profile.streamer_id },
                data: {
                    theme_color,
                    is_nsfw,
                    stream_delay_ms
                }
            });

            if (social_links) {
                await tx.live_streamer_social_links.deleteMany({
                    where: { streamer_id: profile.streamer_id }
                });

                if (social_links.length > 0) {
                    await tx.live_streamer_social_links.createMany({
                        data: social_links.map(link => ({
                            streamer_id: profile.streamer_id,
                            platform: link.platform,
                            url: link.url
                        }))
                    });
                }
            }

            return updated;
        });

        return res.json({ successful: true, data: updatedProfile });
    } catch (err) {
        next(err);
    }
});

router.post('/branding', authenticateToken, handleUpload('image'), async (req, res, next) => {
    try {
        const { type } = req.body; 
        const user_id = req.user.user_id;

        if (!req.file || !['profile_pic', 'banner', 'offline_banner'].includes(type)) {
            return res.status(400).json({ successful: false, message: "Invalid_Image_Or_Type" });
        }

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            select: { streamer_id: true }
        });

        if (!profile) {
            return res.status(404).json({ successful: false, message: "Streamer_Profile_Not_Found" });
        }

        const fileExtension = req.file.originalname.split('.').pop();
        const blobName = `live-branding/${profile.streamer_id}/${type}-${Date.now()}.${fileExtension}`;
        
        const imageUrl = await uploadVideoStream(
            process.env.AZURE_THUMBNAIL_CONTAINER,
            blobName,
            req.file.buffer,
            req.file.mimetype,
            { access: 'blob' }
        );

        const updatePayload = {};
        if (type === 'profile_pic') updatePayload.profile_pic_url = imageUrl;
        if (type === 'banner') updatePayload.banner_url = imageUrl;
        if (type === 'offline_banner') updatePayload.offline_banner_url = imageUrl;

        const updatedProfile = await prisma.live_streamer_profile.update({
            where: { streamer_id: profile.streamer_id },
            data: updatePayload
        });

        return res.json({ successful: true, data: updatedProfile });
    } catch (err) {
        next(err);
    }
});


import { finalizeActiveSessionsForStreamer } from '../services/live-session-finalize.js';

// Reversible channel deactivation. is_active=false hides the streamer from discovery
// and blocks going live (enforced in live-session-routes); data is preserved so the
// creator can reactivate. Deactivating also ends any in-flight session immediately so
// the streamer doesn't linger as "live".
const activeSchema = z.object({ is_active: z.boolean() });

router.patch('/active', authenticateToken, async (req, res, next) => {
    try {
        const validated = activeSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true }
        });

        if (!profile) {
            return res.status(404).json({ successful: false, message: "Streamer_Profile_Not_Found" });
        }

        const { is_active } = validated.data;

        if (!is_active) {
            await finalizeActiveSessionsForStreamer(profile.streamer_id, {
                io: req.app.get('io'),
                status: 'FINISHED',
            });
        }

        const updated = await prisma.live_streamer_profile.update({
            where: { streamer_id: profile.streamer_id },
            data: { is_active }
        });

        return res.json({ successful: true, data: updated });
    } catch (err) {
        next(err);
    }
});

router.post('/categories/bulk', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const categories = [
            { category_name: "Gaming" },
            { category_name: "Just Chatting" },
            { category_name: "Music" },
            { category_name: "Education" },
            { category_name: "Food & Drink" },
            { category_name: "Sports" },
            { category_name: "Software Development" },
            { category_name: "Art & Design" },
            { category_name: "Crypto & Finance" },
            { category_name: "Health & Fitness" }
        ];

        const result = await prisma.live_stream_category.createMany({
            data: categories,
            skipDuplicates: true
        });

        return res.status(201).json({ successful: true, count: result.count });
    } catch (err) {
        next(err);
    }
});


export default router;