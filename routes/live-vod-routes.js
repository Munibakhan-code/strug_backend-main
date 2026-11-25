import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { createClipFromVod } from '../services/live-vod-archive.js';
import { handleLiveThumbUpload, storeLiveThumbnail } from '../utils/live-thumbnail-upload.js';
import { isSubscribed } from '../services/live-subscription.js';

const router = express.Router();

/**
 * Enforce PUBLIC / PRIVATE / SUBSCRIBERS on VOD access (not only browse filters).
 * Owner always allowed. Returns { ok, status, message }.
 */
async function assertVodVisible(vod, userId) {
    if (!vod) return { ok: false, status: 404, message: 'Vod_Not_Found' };
    if (vod.visibility === 'PUBLIC') return { ok: true };
    const ownerId = vod.streamer?.user_id ?? vod.streamer_user_id;
    if (userId && ownerId && userId === ownerId) return { ok: true };
    if (vod.visibility === 'PRIVATE') {
        return { ok: false, status: 403, message: 'Vod_Private' };
    }
    if (vod.visibility === 'SUBSCRIBERS') {
        if (!userId) return { ok: false, status: 401, message: 'Login_Required' };
        const streamerId = vod.streamer_id ?? vod.streamer?.streamer_id;
        if (!streamerId) return { ok: false, status: 403, message: 'Vod_Subscribers_Only' };
        if (await isSubscribed(userId, streamerId)) return { ok: true };
        return { ok: false, status: 403, message: 'Vod_Subscribers_Only' };
    }
    return { ok: false, status: 403, message: 'Vod_Forbidden' };
}

const updateVodSchema = z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional().nullable(),
    visibility: z.enum(['PUBLIC', 'PRIVATE', 'SUBSCRIBERS']).optional()
});

const createClipSchema = z.object({
    vod_id: z.number().int().positive(),
    start_sec: z.number().min(0).default(0),
    duration_sec: z.number().int().min(5).max(60).default(30),
    title: z.string().min(1).max(255).optional(),
});

function formatDuration(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
}

function mapClipRow(v) {
    return {
        id: v.vod_id,
        vod_id: v.vod_id,
        session_id: v.session_id,
        title: v.title,
        description: v.description ?? null,
        streamer: v.streamer?.display_name ?? 'Streamer',
        streamer_user_id: v.streamer?.user_id ?? null,
        handle: v.streamer?.handle ?? null,
        profile_pic_url: v.streamer?.profile_pic_url ?? null,
        category: v.streamer?.category?.category_name ?? 'General',
        thumb: v.thumbnail_url || v.streamer?.profile_pic_url,
        video_url: v.video_url,
        duration: formatDuration(v.duration_sec),
        duration_sec: v.duration_sec,
        views: v.view_count ?? 0,
        created_at: v.created_at,
        is_clip: true,
        clipped_by: v.clipped_by
            ? (v.clipped_by.username || v.clipped_by.name || null)
            : null,
    };
}

/** Create a clip from a public parent VOD (auth required). */
router.post('/clips', authenticateToken, async (req, res, next) => {
    try {
        const body = createClipSchema.parse({
            ...req.body,
            vod_id: Number(req.body?.vod_id),
            start_sec: Number(req.body?.start_sec ?? 0),
            duration_sec: Number(req.body?.duration_sec ?? 30),
        });

        const parent = await prisma.live_vod.findFirst({
            where: {
                vod_id: body.vod_id,
                is_clip: false,
                visibility: 'PUBLIC',
            },
            include: {
                session: true,
            },
        });
        if (!parent) {
            return res.status(404).json({ successful: false, message: 'Parent VOD not found.' });
        }

        const clip = await createClipFromVod({
            parentVod: parent,
            session: parent.session,
            startSec: body.start_sec,
            durationSec: body.duration_sec,
            title: body.title,
            clippedByUserId: req.user.user_id,
        });

        return res.status(201).json({ successful: true, data: mapClipRow(clip) });
    } catch (err) {
        if (err?.name === 'ZodError') {
            return res.status(400).json({ successful: false, message: 'Invalid clip parameters.', errors: (err.issues ?? err.errors) });
        }
        if (err?.code === 'CLIP_UNAVAILABLE' || err?.code === 'CLIP_EXPORT_FAILED' || err?.code === 'CLIP_NO_ARCHIVE') {
            return res.status(503).json({ successful: false, message: err.message, code: err.code });
        }
        if (err?.code === 'CLIP_OUT_OF_RANGE') {
            return res.status(400).json({ successful: false, message: err.message, code: err.code });
        }
        next(err);
    }
});

/** Recent public broadcasts for the live browse hub. */
router.get('/browse', async (req, res, next) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 48);
        const vods = await prisma.live_vod.findMany({
            where: {
                visibility: 'PUBLIC',
                is_clip: false,
                streamer: { is_active: true },
            },
            include: {
                streamer: {
                    select: {
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        category: { select: { category_name: true } },
                    },
                },
            },
            orderBy: { created_at: 'desc' },
            take: limit,
        });

        const data = vods.map((v) => ({
            id: v.vod_id,
            vod_id: v.vod_id,
            session_id: v.session_id,
            title: v.title,
            description: v.description ?? null,
            streamer: v.streamer?.display_name ?? 'Streamer',
            streamer_user_id: v.streamer?.user_id ?? null,
            handle: v.streamer?.handle ?? null,
            profile_pic_url: v.streamer?.profile_pic_url ?? null,
            category: v.streamer?.category?.category_name ?? 'General',
            thumb: v.thumbnail_url || v.streamer?.profile_pic_url,
            video_url: v.video_url,
            duration: formatDuration(v.duration_sec),
            duration_sec: v.duration_sec,
            views: v.view_count ?? 0,
            created_at: v.created_at,
        }));

        return res.json({ successful: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/category/:categoryId', async (req, res, next) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (Number.isNaN(categoryId)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Category_Id' });
        }

        const vods = await prisma.live_vod.findMany({
            where: {
                visibility: 'PUBLIC',
                is_clip: false,
                streamer: { category_id: categoryId, is_active: true },
            },
            include: {
                streamer: {
                    select: {
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        category: { select: { category_name: true } },
                    },
                },
            },
            orderBy: { created_at: 'desc' },
            take: 48,
        });

        const data = vods.map((v) => ({
            id: v.vod_id,
            vod_id: v.vod_id,
            session_id: v.session_id,
            title: v.title,
            description: v.description ?? null,
            streamer: v.streamer?.display_name ?? 'Streamer',
            streamer_user_id: v.streamer?.user_id ?? null,
            handle: v.streamer?.handle ?? null,
            profile_pic_url: v.streamer?.profile_pic_url ?? null,
            category: v.streamer?.category?.category_name ?? 'General',
            thumb: v.thumbnail_url || v.streamer?.profile_pic_url,
            video_url: v.video_url,
            duration: formatDuration(v.duration_sec),
            duration_sec: v.duration_sec,
            views: v.view_count ?? 0,
            created_at: v.created_at,
        }));

        return res.json({ successful: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/category/:categoryId/clips', async (req, res, next) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (Number.isNaN(categoryId)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Category_Id' });
        }

        const clips = await prisma.live_vod.findMany({
            where: {
                visibility: 'PUBLIC',
                is_clip: true,
                streamer: { category_id: categoryId, is_active: true },
            },
            include: {
                streamer: {
                    select: {
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        category: { select: { category_name: true } },
                    },
                },
                clipped_by: { select: { user_id: true, username: true, name: true } },
            },
            orderBy: { created_at: 'desc' },
            take: 48,
        });

        const data = clips.map(mapClipRow);

        return res.json({ successful: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/streamer/:handle', async (req, res, next) => {
    try {
        const { handle } = req.params;

        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { handle: handle.toLowerCase() },
            select: { streamer_id: true, is_active: true }
        });

        // Deactivated streamers are hidden from public VOD listings too.
        if (!streamer || !streamer.is_active) return res.status(404).json({ message: "Streamer_Not_Found" });

        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 48, 1), 100);
        const vods = await prisma.live_vod.findMany({
            where: { 
                streamer_id: streamer.streamer_id,
                visibility: 'PUBLIC' 
            },
            orderBy: { created_at: 'desc' },
            take,
        });

        return res.json({ successful: true, data: vods });
    } catch (err) {
        next(err);
    }
});

router.get('/me', authenticateToken, async (req, res, next) => {
    try {
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id }
        });

        // No streamer profile → no VODs. Return an empty list (200) rather than
        // a 404 so the dashboard load stays free of console-error noise.
        if (!profile) return res.json({ successful: true, data: [] });

        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 48, 1), 100);
        const vods = await prisma.live_vod.findMany({
            where: { streamer_id: profile.streamer_id },
            orderBy: { created_at: 'desc' },
            take,
        });

        return res.json({ successful: true, data: vods });
    } catch (err) {
        next(err);
    }
});

/** Fetch a single VOD/clip with visibility enforcement. */
router.get('/:vod_id', optionalAuth, async (req, res, next) => {
    try {
        const vod_id = Number(req.params.vod_id);
        if (!Number.isInteger(vod_id) || vod_id <= 0) {
            return res.status(400).json({ successful: false, message: 'Invalid_Vod_Id' });
        }
        const vod = await prisma.live_vod.findUnique({
            where: { vod_id },
            include: {
                streamer: {
                    select: {
                        streamer_id: true,
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        category: { select: { category_name: true } },
                    },
                },
            },
        });
        const access = await assertVodVisible(vod, req.user?.user_id);
        if (!access.ok) {
            return res.status(access.status).json({ successful: false, message: access.message });
        }
        return res.json({
            successful: true,
            data: vod.is_clip ? mapClipRow(vod) : {
                ...vod,
                streamer: vod.streamer?.display_name,
                handle: vod.streamer?.handle,
                profile_pic_url: vod.streamer?.profile_pic_url,
                category: vod.streamer?.category?.category_name ?? 'General',
                thumb: vod.thumbnail_url || vod.streamer?.profile_pic_url,
                duration: formatDuration(vod.duration_sec),
            },
        });
    } catch (err) {
        next(err);
    }
});

/** Public: record a VOD/clip view with 10-min dedup (mirrors video-engagement view path). */
router.post('/:vod_id/view', optionalAuth, async (req, res, next) => {
    try {
        const vod_id = Number(req.params.vod_id);
        if (!Number.isInteger(vod_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Vod_Id' });
        }

        const existing = await prisma.live_vod.findFirst({
            where: { vod_id },
            select: {
                vod_id: true,
                view_count: true,
                visibility: true,
                streamer_id: true,
                streamer: { select: { user_id: true, streamer_id: true } },
            },
        });
        const access = await assertVodVisible(existing, req.user?.user_id);
        if (!access.ok) {
            return res.status(access.status).json({ successful: false, message: access.message });
        }

        const userId = req.user?.user_id || null;
        const identifier = userId ? `user:${userId}` : `ip:${req.ip}`;
        const viewLockKey = `live_vod:views:lock:${vod_id}:${identifier}`;
        const VIEW_WINDOW_MS = 600 * 1000; // 10 min
        const now = new Date();

        try {
            const isLocked = await redis.get(viewLockKey);
            if (isLocked) {
                return res.json({
                    successful: true,
                    counted: false,
                    data: { vod_id, views: existing.view_count },
                });
            }
        } catch { /* redis degraded — fall through to DB dedup */ }

        const recent = await prisma.live_vod_view.findUnique({
            where: { vod_id_identifier: { vod_id, identifier } },
        });
        if (recent && now.getTime() - new Date(recent.viewed_at).getTime() < VIEW_WINDOW_MS) {
            try { await redis.set(viewLockKey, '1', 'EX', 600); } catch { /* optional */ }
            return res.json({
                successful: true,
                counted: false,
                data: { vod_id, views: existing.view_count },
            });
        }

        await prisma.live_vod_view.upsert({
            where: { vod_id_identifier: { vod_id, identifier } },
            update: { viewed_at: now },
            create: { vod_id, identifier, viewed_at: now },
        });
        try { await redis.set(viewLockKey, '1', 'EX', 600); } catch { /* optional */ }

        const updated = await prisma.live_vod.update({
            where: { vod_id },
            data: { view_count: { increment: 1 } },
            select: { vod_id: true, view_count: true },
        });

        return res.json({
            successful: true,
            counted: true,
            data: { vod_id, views: updated.view_count },
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/:vod_id', authenticateToken, async (req, res, next) => {
    try {
        const vod_id = Number(req.params.vod_id);
        const validated = updateVodSchema.parse(req.body);

        const vod = await prisma.live_vod.findUnique({
            where: { vod_id },
            include: { streamer: true }
        });

        if (!vod || vod.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ message: "Unauthorized" });
        }

        const data = { ...validated };
        if (validated.description !== undefined) {
            data.description = validated.description?.trim() || null;
        }

        const updated = await prisma.live_vod.update({
            where: { vod_id },
            data
        });

        return res.json({ successful: true, data: updated });
    } catch (err) {
        next(err);
    }
});

router.post('/:vod_id/thumbnail', authenticateToken, handleLiveThumbUpload('image'), async (req, res, next) => {
    try {
        const vod_id = Number(req.params.vod_id);
        if (!Number.isInteger(vod_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid VOD id.' });
        }

        const vod = await prisma.live_vod.findUnique({
            where: { vod_id },
            include: { streamer: true },
        });
        if (!vod || vod.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: 'Unauthorized' });
        }

        const thumbnail_url = await storeLiveThumbnail(req, {
            prefix: 'live-vod-thumbs',
            streamerId: vod.streamer_id,
            entityId: vod_id,
        });

        const updated = await prisma.live_vod.update({
            where: { vod_id },
            data: { thumbnail_url },
        });

        return res.json({ successful: true, data: updated });
    } catch (err) {
        if (err?.code === 'NO_FILE') {
            return res.status(400).json({ successful: false, message: 'Image file is required.' });
        }
        next(err);
    }
});

router.delete('/:vod_id', authenticateToken, async (req, res, next) => {
    try {
        const vod_id = Number(req.params.vod_id);

        const vod = await prisma.live_vod.findUnique({
            where: { vod_id },
            include: { streamer: true }
        });

        if (!vod || vod.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ message: "Unauthorized" });
        }

        const liveVodContainer = process.env.AZURE_LIVE_VOD_CONTAINER || 'live-vods';
        if (vod.video_url?.includes('blob.core.windows.net')) {
            const container = vod.video_url.includes(`/${liveVodContainer}/`)
                ? liveVodContainer
                : (process.env.AZURE_PROCESSED_VIDEO_CONTAINER || 'videos-processed');
            await deleteAzureBlob(container, vod.video_url);
        }
        if (vod.thumbnail_url) {
            await deleteAzureBlob(process.env.AZURE_THUMBNAIL_CONTAINER, vod.thumbnail_url);
        }

        await prisma.live_vod.delete({
            where: { vod_id }
        });

        return res.json({ successful: true, message: "VOD_Deleted" });
    } catch (err) {
        next(err);
    }
});

// Azure Communication Services recording callback (Event Grid). Writes a live_vod row
// from the recording-ready event. This endpoint is internet-reachable and previously
// trusted its body blindly — anyone could forge a VOD on any profile. It is now gated by
// a shared secret (set RECORDER_HOOK_SECRET, or reuse LIVE_HOOK_SECRET) supplied either in
// the `x-webhook-secret` header or the `?secret=` query string of the subscription URL.
const RECORDER_HOOK_SECRET = process.env.RECORDER_HOOK_SECRET || process.env.LIVE_HOOK_SECRET;

router.post('/callback/azure-recorder', async (req, res, next) => {
    // Fail closed: no secret configured, or supplied secret does not match.
    const supplied = req.get('x-webhook-secret') || req.query.secret;
    if (!RECORDER_HOOK_SECRET || supplied !== RECORDER_HOOK_SECRET) {
        return res.status(403).json({ successful: false, message: "Forbidden" });
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];

    // Event Grid subscription-validation handshake (sent once on subscribe).
    const validation = events.find(
        e => e?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent'
    );
    if (validation) {
        return res.status(200).json({ validationResponse: validation.data?.validationCode });
    }

    try {
        for (const eventData of events) {
            if (eventData?.type !== 'Microsoft.Communication.RecordingFileStatusUpdated') continue;

            // Validate the structure instead of trusting attacker-shaped bodies.
            const session_id = Number(eventData?.subject?.split('/')?.[1]);
            const streamer_id = Number(eventData?.data?.metadata?.streamerId);
            const video_url = eventData?.data?.recordingStorageInfo?.contentLocation;
            const durationMs = Number(eventData?.data?.recordingDurationMs);

            if (!Number.isInteger(session_id) || !Number.isInteger(streamer_id) || !video_url) {
                console.warn('[azure-recorder] malformed recording event, skipping', {
                    subject: eventData?.subject
                });
                continue;
            }

            // Only write VODs for sessions that actually belong to the named streamer.
            const session = await prisma.live_session.findUnique({ where: { session_id } });
            if (!session || session.streamer_id !== streamer_id) {
                console.warn('[azure-recorder] session/streamer mismatch, skipping', {
                    session_id, streamer_id
                });
                continue;
            }

            await prisma.live_vod.create({
                data: {
                    session_id,
                    streamer_id,
                    video_url,
                    title: `Archive: ${new Date().toLocaleDateString()}`,
                    duration_sec: Number.isFinite(durationMs) ? durationMs / 1000 : 0
                }
            });
        }

        return res.status(200).json({ successful: true });
    } catch (err) {
        // Surface failures (was previously masked as 200 OK_WITH_ERR).
        next(err);
    }
});

export default router;